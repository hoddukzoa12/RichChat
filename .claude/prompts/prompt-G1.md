## 목표

**Android SMS Gateway의 수신 웹훅을 받는다.** 이번 슬라이스는 **SMS 수신만**이다.

LGU+ 메시지허브를 걷어내고 사무실 업무폰 9대를 하나의 인박스로 모은다.
**LGU+ 코드는 이 슬라이스에서 건드리지 마라** — 전환 중 고객 문의를 잃지 않도록
병행 운영한다.

## 왜 바꾸나

LGU+는 SMS 수신이 **KT 가입자만** 도착하고(SKT·U+ 미수신), 발신번호가 미등록이며,
문서와 실제가 일곱 군데 달랐다. 사무소에는 이미 업무폰 9대가 있고
그것들을 통합하는 것이 원래 목적이다.

## 확인된 계약 — 내가 소스와 OpenAPI로 직접 확인했다

### 웹훅 인증 (HMAC-SHA256)

```
X-Signature   16진수 HMAC
X-Timestamp   Unix 초
```

**서명 대상은 `원문 본문 + 타임스탬프 값`을 이어붙인 것**이고, 키는 앱의
`Settings → Webhooks → Signing Key`다. **상수 시간 비교**로 검증해라.

**타임스탬프가 오래된 요청은 거부해라.** 서명만 검사하면 재전송 공격이 통한다.
허용 창은 네가 정하고 근거를 적어라.

### `sms:received` 페이로드

```json
{
  "deviceId": "ffffffffceb0b1db0000018e937c815b",
  "event": "sms:received",
  "id": "Ey6ECgOkVVFjz3CL48B8C",
  "webhookId": "LreFUt-Z3sSq0JufY9uWB",
  "payload": {
    "messageId": "abc123",
    "message": "본문",
    "sender": "6505551212",
    "recipient": "+1234567890",
    "simNumber": 1,
    "receivedAt": "2024-06-22T15:46:11.000+07:00"
  }
}
```

### 이 저장소가 특히 조심할 점

- **`receivedAt`에 타임존 오프셋이 붙어 온다.** LGU+는 오프셋이 없어 직접
  파싱해야 했지만 **이건 표준 형식이다.** 예시의 `+07:00`을 보라 —
  **KST라고 가정하지 마라.** 오프셋을 그대로 해석해라
- **`recipient`는 `null`일 수 있다** (권한에 따라). 문서에 명시돼 있다.
  **번호가 아니라 `deviceId`를 라우팅 키로 써라**
- **멱등 키는 `payload.messageId`다.** 봉투의 `id`는 전달 식별자라
  재전송 때 달라질 수 있다. **봉투 `id`로 중복을 판정하지 마라**
- **모르는 `event` 값에 고객 메시지를 버리지 마라.** 이 슬라이스는
  `sms:received`만 처리하지만, 나머지 이벤트는 **정상 응답하고 넘겨라.**
  거부하면 게이트웨이가 재전송을 반복한다. 전체 목록:
  `sms:received` `sms:data-received` `sms:sent` `sms:delivered` `sms:failed`
  `mms:received` `mms:downloaded` `system:ping`

## 반드시 재사용할 것 — 새로 만들지 마라

`worker/routes/hooks-mo.ts:441`의 `processItem`이 **인박스 저장 불변식 전체**를
담고 있다 (240줄):

- 고객 upsert · 대화 upsert
- 메시지 멱등 insert (`ON CONFLICT(mo_key) WHERE mo_key IS NOT NULL`)
- `inbound_count` 이중 증가 방지
- **정렬키 후퇴 방지 가드** (`?occurred >= last_message_at`)
- `완료` 대화에 수신 시 `미처리` 복귀
- 같은 트랜잭션의 이벤트 발행

**이것들은 독립 리뷰를 세 번 거쳐 확정된 것이다. 다시 구현하면 반드시 틀린다.**

**사업자 중립 모듈로 추출해서 양쪽이 쓰게 해라.** 추출은 리팩터이고
**동작을 바꾸면 안 된다.** 기존 MO 테스트가 **하나도 수정 없이** 통과해야 한다.
수정이 필요하면 그건 동작을 바꾼 것이다.

추출된 입력은 사업자 개념이 없어야 한다 — 고객 번호, 채널, 본문, 발생 시각,
멱등 키, 수신 채널(어느 폰) 정도다. 정확한 모양은 네가 설계해라.

## 커밋 우선 — ack가 아니다

`AGENTS.md`가 못 박은 규칙이 그대로 적용된다.

**D1 커밋 뒤에만 성공 응답을 반환해라.** 먼저 ack하고 `waitUntil`로 미루면
isolate가 죽을 때 고객 메시지를 잃는다.

게이트웨이가 재전송을 어떤 응답 코드로 판단하는지 **문서에서 확인**하고,
확인 못 하면 `ask`로 알려라. 추측하지 마라.

## 스키마

`office_channels`에 **`device_id`**를 더한다. `migrations/0007_*.sql`을 새로 만들어라.
기존 마이그레이션을 고치지 마라.

`0005`가 `users` 재생성에서 겪은 함정이 있으니 **그 파일을 먼저 읽어라.**
컬럼 추가는 `ALTER TABLE ... ADD COLUMN`으로 되므로 재생성이 필요 없다.

`device_id`로 사무소 채널을 찾지 못하면 어떻게 할지 판단해라 —
**모르는 폰이 보낸 메시지를 버리지 마라.** 근거를 보고에 적어라.

## 설정

시크릿 이름은 네가 정하고 `wrangler.jsonc`의 `secrets.required`에 더해라.
`.dev.vars.example`에도 기존 서술 방식대로 항목을 추가해라 —
누가 발급하는가 / 어디서 구하는가 / 없으면 무엇이 안 되는가.

**실제 시크릿 값을 만들거나 커밋하지 마라.**

## 건드리지 말 것

- `worker/lgu/` 전체
- `worker/routes/hooks-report.ts`, `worker/routes/messages-send.ts`
- `worker/scheduled.ts`
- `src/` 전체
- `AGENTS.md`·`CLAUDE.md`·계획서 — 고칠 것이 보이면 보고에 적어라

`hooks-mo.ts`는 **추출을 위해서만** 손대라. 동작을 바꾸지 마라.

## 수용 기준

1. `npm run check` 통과
2. **기존 MO 테스트가 수정 없이 전부 통과한다** — 추출이 리팩터임의 증거다
3. **서명이 틀리면 거부한다.** 올바른 서명으로 만든 요청은 통과한다
4. **타임스탬프가 오래된 요청은 거부한다** (재전송 방어)
5. 같은 `payload.messageId` 2회 → **메시지 1건**, `inbound_count` 1 증가,
   둘 다 성공 응답
6. **봉투 `id`가 달라도** 같은 `messageId`면 중복 저장되지 않는다
7. `receivedAt`의 **오프셋이 반영된다** — `+07:00`과 `+09:00`을 각각 넣어
   저장된 시각이 다른지 확인해라
8. `recipient`가 `null`이어도 **`deviceId`로 채널을 찾아 저장한다**
9. 처리하지 않는 이벤트(`system:ping` 등)에 **성공 응답**한다
10. `완료` 대화에 수신 → `미처리` 복귀 (기존 불변식 유지)
11. **D1 커밋 전에 성공 응답을 반환하지 않는다**
12. LGU+ MO 경로가 **여전히 동작한다** — 병행 운영이다

커밋하고 `origin/hoddukzoa12/g1-gateway-inbound`에 푸시한 뒤 해시를 보고해라.
배포하지 마라.
