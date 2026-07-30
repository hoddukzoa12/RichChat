## 목표

**업무폰으로 문자를 보낸다.** 지금 발송은 LGU+로만 나가고 그마저
`22002 미등록 발신번호`로 막혀 있다. **실제로는 아무것도 못 보낸다.**

## 확인된 계약 — 내가 OpenAPI로 직접 확인했다

```
POST {SMS_GATEWAY_API_URL}/messages
Authorization: Basic <계정 자격>

{ "id": "<우리 client_key>",        ← 클라이언트가 지정. 멱등성
  "deviceId": "c_5q5uNZ...",        ← 어느 업무폰으로 보낼지
  "textMessage": { "text": "본문" },
  "phoneNumbers": ["+8210..."],     ← 필수
  "simNumber": 1,
  "withDeliveryReport": true }
```

응답: `{ id, deviceId, state, recipients: [{ phoneNumber, state, error }] }`

**상태값** — `Pending | Processed | Sent | Delivered | Failed`

우리 `delivery_status`와 거의 1:1이다:

```
Pending → Processed → Sent → Delivered | Failed
 대기   →   접수    → 전송중 →  완료   |  실패
```

**기존 단조 전이 불변식이 그대로 살아난다.** 허용 선행 상태를 `WHERE`에 넣어
재생·역순 리포트가 0행이 되게 하는 규칙(`AGENTS.md`)을 유지해라.

**단문만 된다.** 앱이 MMS 발신을 지원하지 않는다(소스에서 `sendMultimediaMessage`
호출 0건). 첨부 발송 경로는 **이 슬라이스에서 다루지 마라.**

## 어느 폰으로 보내나 — 대화가 정한다

**상담원이 고르지 않는다.** G2에서 대화가 업무폰(`office_channels`)에 묶였다.
그 채널의 `device_id`로 보낸다.

- 대화의 채널이 **게이트웨이 기기**면 게이트웨이로 보낸다
- 대화의 채널에 `device_id`가 **없으면**(LGU+ 대표번호) 기존 LGU+ 경로로 보낸다
- 채널이 **없거나 비활성**이면 어떻게 할지 판단해라.
  **보낸 척하지 마라** — 사람이 읽을 수 있는 실패여야 한다

전환 기간이라 **두 경로가 공존한다.** LGU+ 발송 코드를 지우지 마라.

## 설정 — 이름을 못 박는다

병렬로 도는 다른 슬라이스와 공유한다. **아래를 그대로 써라.**

```
SMS_GATEWAY_API_URL    vars    관리 API 기준 주소
SMS_GATEWAY_USERNAME   secret  계정 아이디
SMS_GATEWAY_PASSWORD   secret  계정 비밀번호
```

Access 헤더는 **기존 `CF_ACCESS_CLIENT_ID`·`CF_ACCESS_CLIENT_SECRET`을 재사용**한다.
관리 API가 Access로 보호된 경로에 있다.

`wrangler.jsonc`에 위 셋이 없으면 **최소로 추가해라.** 다른 슬라이스가 같은 줄을
넣을 수 있다 — 병합은 내가 한다.

## 멱등성 — 기존 것을 그대로 쓴다

`messages.client_key`가 이미 발송 멱등 키다. **그것을 게이트웨이의 `id`로 보내라.**

같은 `client_key`로 두 번 요청해도 **메시지 1건, 게이트웨이 호출 1회**여야 한다.
기존 3단계 발송(대기 → 호출 → 접수)이 이미 그렇게 되어 있으니 **구조를 갈아엎지
마라.**

## 반드시 지킬 것

- **전역 `fetch`를 객체 속성에 담았다가 호출하지 마라.** 오늘 그것 때문에 운영이
  100% 실패했다(`Illegal invocation`). 맨 호출로 써라
- **문서 모양으로 목을 만들지 마라.** 위 계약은 OpenAPI 실측이다. 그대로 써라
- 발송은 **발신번호 등록과 무관하다** — 게이트웨이는 폰 자기 번호로 보낸다.
  다만 **실제 발송은 내가 운영에서 확인한다.** 네가 검증할 수 없는 구간이다
- `worker/routes/hooks-*.ts`·`worker/inbound-message.ts`를 건드리지 마라
- `worker/routes/office.ts`·`src/components/OfficePhonesCard.tsx`·
  `shared/wire/office.ts`를 건드리지 마라 — **다른 슬라이스가 작업 중이다**
- `AGENTS.md`·`CLAUDE.md`·계획서를 고치지 마라

## 소유 파일

`worker/gateway/send.ts`(새 파일), `worker/routes/messages-send.ts`,
`worker/lgu/send.ts`(필요한 만큼), `shared/wire/message-send.ts`,
`wrangler.jsonc`, `.dev.vars.example`, 테스트.

## 수용 기준

1. `npm run check` 통과
2. **대화의 채널이 게이트웨이면 게이트웨이로 나간다** — 목이 받은 요청 본문으로
   확인해라. `deviceId`가 그 대화의 것인지도
3. **채널에 `device_id`가 없으면 LGU+로 나간다** (기존 경로 유지)
4. **Access 헤더가 실린다** — 목이 받은 헤더로 확인
5. **같은 `client_key` 2회 → 메시지 1건, 게이트웨이 호출 1회**
6. 게이트웨이 상태가 `delivery_status`로 **단조롭게** 매핑된다.
   역순 상태가 와도 후퇴하지 않는다
7. 채널이 없거나 비활성이면 **사람이 읽을 수 있는 실패**다. 조용히 성공하지 않는다
8. 게이트웨이가 오류를 주면 메시지가 `실패`로 남고 `error_text`에 이유가 있다
9. 기존 LGU+ 발송 테스트가 **수정 없이** 통과한다
10. `dead-exports.py` · `positional-consts.py` 통과

커밋하고 `origin/hoddukzoa12/g5-gateway-send`에 푸시한 뒤 해시를 보고해라.
배포하지 마라.
