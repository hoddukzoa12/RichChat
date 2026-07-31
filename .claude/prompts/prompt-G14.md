# G14 — MMS 두 이벤트의 ID가 달라 메시지가 2건으로 갈라진다

`AGENTS.md`를 먼저 읽고 그 원칙을 따라라.

## 운영 실측 — 이것이 정본이다

G12는 `mms:received`와 `mms:downloaded`의 `messageId`가 같다는 전제로 병합을
설계했다. **운영에서 다르게 왔다.** 2026-07-31 실제 D1 행이다:

| kst | mo_key 접미 | body |
|---|---|---|
| 09:30:21 | `ZxqUf3r1` (received — transactionId) | **빈 값** |
| 09:30:22 | `2249` (downloaded — 프로바이더 숫자 id) | 전문 153자 |
| 09:31:01 | `ZaqUfdE0` | 빈 값 |
| 09:31:02 | `2251` | 빈 값 |
| 10:04:11 | `AEqUnzOZ` | 빈 값 |
| 10:04:12 | `2253` | "가는길" + 사진 |

앱 소스의 `messageId = message.messageId ?: message.transactionId`에서 헤더
이벤트는 **항상 transactionId 폴백**으로 왔다. 두 키가 절대 안 만나므로
멱등 병합이 성립하지 않아 **모든 MMS가 2건**이 된다. 고객 화면에 빈 유령
메시지가 하나씩 낀다.

제목도 오염돼 있다. 통신사가 subject를 자동 생성한다 — 실측 세 형태:

- `제목없음`
- `[제목없음]`
- 본문 앞부분을 자른 사본 (`안녕하세요. 한국오에이렌`)

지금 title로 저장돼 화면에서 본문과 **중복 렌더**된다.

## 무엇을 하는가

### ① `mms:received`는 인박스 메시지를 만들지 않는다

`mms:downloaded`에는 `transactionId`가 없다. **결정적으로 이을 방법이 없다.**

- 발신번호+시간창 같은 **추측으로 잇지 마라.** 같은 고객이 연달아 보낸 두
  MMS가 섞이는 쪽이 유령 행보다 나쁘다
- 헤더 수신 사실은 **진단용으로만 남겨라** (형태는 네가 정하되 고객 대화에
  보이면 안 된다). 다운로드가 영영 안 오는 MMS를 운영자가 알 수 있어야 한다
- 인박스 행은 **`mms:downloaded`만** 만든다. 이미 그 단독 저장 경로가 있다
- 혹시 두 이벤트의 키가 같게 오는 기기가 있더라도 기존 멱등 처리가 자연히
  막는다 — 그 경우를 위한 분기를 새로 만들지 마라

### ② 통신사 자동 subject를 title로 저장하지 않는다

실측 세 형태(`제목없음`, `[제목없음]`, 본문의 접두사인 subject)는 **버려라.**
정규화(공백·괄호) 방법은 네가 정하되 세 형태가 테스트로 잠겨야 한다.
그 외의 subject는 사용자가 직접 쓴 제목일 수 있으니 유지한다.

### G12 테스트 갱신에 대해

기존 G12 테스트 일부는 두 이벤트가 같은 `messageId`로 온다고 가정한다.
**그 가정 자체가 틀렸으므로 계약 변경에 맞게 고쳐도 된다.** 단, 리뷰 반례가
지키던 불변식 — 본문·사진이 세대 간에 섞이지 않는다, 0바이트 완료가 없다,
정렬키가 후퇴하지 않는다 — 은 **계속 덮여야 한다.** `mms:downloaded` 재생의
지문 CAS는 그대로 필요하다 (같은 숫자 id로 재시도가 온다).

## 건드리지 마라

`worker/lgu/`, `migrations/`(새 마이그레이션 불필요 — 필요해 보이면 `ask`),
`wrangler.jsonc`, `worker/scheduled.ts`.

**`AGENTS.md`·`CLAUDE.md`·계획서를 고치지 마라.**

## 수용 기준

테스트 페이로드는 **위 실측 형태 그대로** 써라 — received는 transactionId형
키, downloaded는 숫자형 키. 같은 id로 흉내 내지 마라.

1. `npm run check` 통과
2. **received → downloaded 순서로 실제 웹훅을 보내면 인박스에 정확히 1건**
   (downloaded가 만든 것), 유령 행 0건
3. downloaded만 와도 1건
4. **received만 오고 downloaded가 안 오면 인박스 0건**, 진단 흔적 1건
5. 같은 downloaded 재생·다른 내용 재생에서 기존 지문 CAS 불변식 유지
6. 실측 세 subject 형태가 title로 저장되지 않고, 그 외 subject는 유지된다
7. 사진 첨부 경로가 그대로 동작한다 (R2 왕복 바이트 일치)
8. LGU+ MO 테스트가 수정 없이 통과한다
9. `python3 .claude/scripts/dead-exports.py` · `positional-consts.py` ·
   `unwired-routes.py` · `routes.py` 통과
10. 커밋하고 `origin/hoddukzoa12/g14-mms-event-identity`에 푸시한 뒤 해시를
    보고해라. **배포하지 마라.**

기존 운영 데이터의 유령 행 정리는 이 슬라이스 밖이다 — 조정자가 배포 후 직접 한다.

## 막히면

범위가 애매하면 혼자 판단하지 말고 `ask`로 물어라. 답을 기다리며 멈추지 말고
막힌 지점만 남기고 나머지를 진행해라. 10분 내 답이 없으면 `escalation`을 올려라.
