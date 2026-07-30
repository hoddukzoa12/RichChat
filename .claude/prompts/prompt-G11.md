# G11 — 업무폰 발송 상태를 게이트웨이 웹훅으로 잇는다

`AGENTS.md`를 먼저 읽고 그 원칙을 따라라.

## 지금 상태

업무폰으로 보낸 문자는 고객에게 **정상 도착하는데 화면에서는 `접수`에 멈춰 있다.**
게이트웨이가 `sms:sent`·`sms:delivered`·`sms:failed` 웹훅을 보내는데
`worker/routes/hooks-sms-gateway.ts:349`가 전부 버린다.

```ts
if (event !== SMS_RECEIVED_EVENT) return successResponse()
```

운영 게이트웨이에 이 세 이벤트가 **이미 등록돼 있다.** 지금도 요청이 오고 있고
우리가 204로 버리는 중이다.

## 매핑

앱이 보내는 `payload.messageId`는 **우리가 발송할 때 넣은 `client_key`와 같다**
(`worker/gateway/send.ts`가 `id: input.clientKey`로 보낸다). 매핑 테이블을
만들지 마라.

| 이벤트 | `delivery_status` | payload에 있는 것 |
|---|---|---|
| `sms:sent` | `전송중` | `sentAt`, `partsCount` |
| `sms:delivered` | `완료` | `deliveredAt` |
| `sms:failed` | `실패` | `failedAt`, `reason` |

세 payload 모두 `messageId`, `sender`, `recipient`, `simNumber`를 갖는다.

## 반드시 재사용할 것

**`worker/db/delivery.ts`의 `applyDeliveryReports`와
`PREVIOUS_DELIVERY_STATUSES`를 그대로 써라.** 상태 전이 규칙을 새로 쓰면
그게 두 번째 진실이다. LGU+ 리포트가 이미 그 경로로 흐른다.

전이는 허용 선행 상태를 `WHERE`에 넣어 단조롭게 유지된다 — 재생·역순 리포트가
0행이 되어야 한다. **`완료`나 `실패`에서 되돌아가면 안 된다.**

## 모르는 것을 조용히 버리지 마라

지금 이 결함이 **정확히 그래서 늦게 발견됐다.** 로그도 흔적도 없었다.

- 처리하지 않는 이벤트(`sms:cancelled`, `app:started`, `system:ping` 등)를
  받으면 **버리되 무엇이 왔는지는 남겨라.** 200/204 응답은 유지한다 —
  게이트웨이의 재전송을 부르지 마라
- 아는 이벤트인데 **본문을 해석할 수 없으면** 원본을 보관해라.
  `mo_failures`가 이미 그 목적의 격리 테이블이다 (`raw_json`, `error_text`,
  `attempts`, `first_at`, `last_at`). 발송 리포트에 그 테이블을 쓸지 새 경로를
  둘지는 네가 정하되, **원본이 남는 것이 조건이다**
- `messageId`에 해당하는 메시지가 없으면 오류가 아니다. 남기고 넘어가라

## 시각 파싱을 문서로 하지 마라

payload의 시각 필드가 어떤 형식으로 오는지 **우리는 실제 값을 아직 못 봤다.**
이 저장소는 같은 실수를 두 번 했다 — LGU+ `moRecvDt`가 문서와 달랐고,
`contentInfoLst`가 `[]`가 아니라 `null`이었다.

**넓게 받아라.** ISO 8601(오프셋 있는 것과 없는 것), epoch 밀리초, epoch 초를
모두 시도하고, 해석 실패를 **메시지 거부로 만들지 마라** — 상태는 갱신하고
시각만 비우거나 수신 시각으로 대체해라. 무엇을 선택했는지 주석에 남겨라.

## 화면까지 흘러야 한다

부품만 만들지 마라. 이 저장소에서 실시간 팬아웃이 **아무도 호출하지 않는 상태**로
병합된 적이 있다. 상태가 바뀌면 `broadcastAfterCommit`으로 **커밋 후에**
브로드캐스트해서 열려 있는 화면이 갱신돼야 한다. LGU+ 리포트 경로가 이미
그렇게 한다 — 같은 방식을 따라라.

## 건드리지 마라

`worker/scheduled.ts`, `worker/lgu/`, `migrations/`(격리 테이블을 새로 만들어야
한다면 `ask`로 물어라), `wrangler.jsonc`.

**`AGENTS.md`·`CLAUDE.md`·계획서를 고치지 마라.** 고쳐야 할 것이 보이면
보고에 적어라.

## 수용 기준

부품이 아니라 **끝에서 끝까지** 확인해라.

1. `npm run check` 통과
2. **업무폰으로 발송한 메시지에 `sms:sent` 웹훅이 오면 `전송중`이 된다.**
   라우트로 실제 요청을 보내 D1 행을 확인해라
3. 이어서 `sms:delivered`가 오면 `완료`가 되고 `delivered_at`이 채워진다
4. `sms:failed`가 오면 `실패`가 되고 **`reason`이 사람이 읽을 수 있는 형태로
   저장된다**
5. **역순·재생이 0행이다** — `완료` 뒤에 `sms:sent`가 와도 `전송중`으로
   되돌아가지 않는다. 같은 웹훅을 두 번 보내도 결과가 같다
6. **서명 검증이 그대로 걸린다** — 다른 키로 서명한 리포트는 401이고 상태가
   안 바뀐다
7. 처리하지 않는 이벤트가 와도 **500이 아니고**, 무엇이 왔는지 남는다
8. 해석 불가능한 본문이 와도 **원본이 보관된다.** 반례를 실제로 넣어 확인해라
9. **열려 있는 화면이 갱신된다.** 브로드캐스트가 실제로 나가는지 확인해라 —
   함수를 직접 부르지 말고 웹훅 요청으로 확인해라
10. LGU+ 리포트 경로가 **깨지지 않는다.** 아직 병행 운영한다
11. `python3 .claude/scripts/dead-exports.py` · `positional-consts.py` ·
    `unwired-routes.py` · `routes.py` 통과
12. 커밋하고 `origin/hoddukzoa12/g11-gateway-delivery-reports`에 푸시한 뒤
    해시를 보고해라. **배포하지 마라.**

## 막히면

범위가 애매하면 혼자 판단하지 말고 `ask`로 물어라. 답을 기다리며 멈추지 말고
막힌 지점만 남기고 나머지를 진행해라. 10분 내 답이 없으면 `escalation`을 올려라.
