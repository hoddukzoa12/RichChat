# G12 — 업무폰 MMS 수신 (긴 문의·사진)

`AGENTS.md`를 먼저 읽고 그 원칙을 따라라.

## 지금 고객 문의가 사라지고 있다

고객이 **70자 넘는 문자**를 보내면 통신사가 MMS로 전환한다. 폰에는 도착하는데
**인박스에는 뜨지 않는다.** `worker/routes/hooks-sms-gateway.ts`가 `sms:received`가
아닌 이벤트를 저장하지 않기 때문이다.

한국어 문의는 대개 짧지 않다. **지금 유실 중인 실제 결함이다.**

운영 게이트웨이에 `mms:received`와 `mms:downloaded`가 **이미 등록돼 있다.**

## 이벤트가 둘이고, 순서가 있다

안드로이드 MMS는 알림이 먼저 오고 내용을 나중에 내려받는다. 앱이 그 두 시점을
그대로 두 웹훅으로 쏜다.

| 이벤트 | 싣는 것 |
|---|---|
| `mms:received` | `messageId`, `sender`, `recipient`, `simNumber`, `transactionId`, `subject`, `size`, `contentClass`, `receivedAt` — **본문 없음** |
| `mms:downloaded` | 위에 더해 **`body`**, `subject`, **`attachments[]`**, `receivedAt` |

`attachments[]`의 각 항목: `partId`, `contentType`, `name`, `size`, `data`(Base64).

### 여기서 반드시 틀리지 마라

두 이벤트의 `messageId`가 **같다.** 지금 멱등 키 규칙이
`sms-gateway/<deviceId>/<messageId>`이므로 **두 이벤트가 같은 `mo_key`를 만든다.**

`ON CONFLICT DO NOTHING`으로 두 번째를 버리면 **헤더만 남고 본문이 영영 안 들어온다.**
빈 메시지가 인박스에 뜨고 아무도 원인을 모른다.

**먼저 온 것으로 행을 만들고, 뒤에 온 내용으로 채워라.** 순서가 뒤바뀌어 와도
같은 결과여야 한다 — `mms:downloaded`가 먼저 오고 `mms:received`가 나중에 와도
본문이 지워지면 안 된다.

## 실제 값이 정본이다

이 저장소는 문서를 믿었다가 두 번 다쳤다. `contentInfoLst`가 `[]`가 아니라
`null`이었고, `moRecvDt` 형식이 문서와 달랐다. **모든 고객 문자가 거부됐다.**

- **`data`가 `null`일 수 있다.** 앱이 빈 파트에 `null`을 넣는다
  (`MmsContentReader.kt:161`). **오류로 다루지 마라**
- `subject`도 `null`이 온다
- 문서에 없는 필드가 올 수 있다. **모르는 필드를 오류로 다루지 마라**
- 시각 형식은 **실제로 못 봤다.** ISO 8601·epoch 밀리초·epoch 초를 모두 시도하고,
  해석 실패를 메시지 거부로 만들지 마라

## 본문과 첨부를 가르는 규칙

MMS는 본문 자체가 `text/plain` 파트다. 그래서 `body`와 `attachments`에 **같은
텍스트가 중복으로 들어온다.**

`text/*` 파트가 `body`와 같은 내용이면 **첨부로 만들지 마라.** 상담원이
`문의.txt` 같은 것을 받게 된다.

## 저장 위치는 이미 있다

**새로 만들지 마라.** LGU+ MMS 경로가 쓰던 것을 그대로 쓴다.

- `message_attachments` 테이블 (`migrations/0002_attachments.sql`)
- R2 키는 `attachmentObjectKey(attachment.id)`

Base64를 디코드해 R2에 넣고 `download_status`를 `완료`로, `r2_key`를 채운다.
LGU+ 경로처럼 나중에 크론이 받아오는 구조가 아니다 — **바이트가 이미 손에 있다.**

크기 상한을 정해라. 상한을 넘으면 첨부를 저장하지 않되 **메시지는 살리고
원본은 격리 테이블에 남겨라.** 무엇을 상한으로 정했는지 주석에 근거를 적어라.

`mms:downloaded`가 **여러 번 와도 첨부가 중복되지 않아야 한다.**
앱이 다운로드를 3회까지 재시도한다 (`MMS_DOWNLOAD_MAX_RETRIES`).

## 커밋 우선

`AGENTS.md`의 규칙을 지켜라 — **D1 커밋 후에만** 성공 응답을 돌려준다.
먼저 응답하고 `waitUntil`로 미루면 isolate가 죽을 때 고객 메시지를 잃는다.
R2 업로드가 실패하면 첨부는 실패로 기록하되 **본문은 저장돼야 한다.**

## 건드리지 마라

`worker/lgu/`, `worker/scheduled.ts`의 LGU+ 보정, `wrangler.jsonc`.
마이그레이션이 필요하면 `ask`로 물어라.

**`AGENTS.md`·`CLAUDE.md`·계획서를 고치지 마라.** 고쳐야 할 것이 보이면
보고에 적어라.

## 수용 기준

부품이 아니라 **끝에서 끝까지** 확인해라.

1. `npm run check` 통과
2. **`mms:received` 다음 `mms:downloaded`가 오면 본문이 있는 메시지 한 건이 된다.**
   두 건이 되거나 본문이 비면 실패다. 라우트로 실제 요청을 보내 D1을 확인해라
3. **순서가 뒤바뀌어도 같은 결과다**
4. **`mms:downloaded`만 와도 저장된다** (헤더 웹훅이 유실될 수 있다)
5. 같은 웹훅이 **여러 번 와도 메시지·첨부가 중복되지 않는다**
6. **사진 첨부가 R2에 실제로 올라가고 다시 내려받아진다.** 바이트가 원본과 같은지
   확인해라
7. `data`가 `null`인 파트, `subject`가 `null`, 모르는 필드가 있어도 **저장된다**
8. `body`와 같은 `text/*` 파트가 **첨부로 만들어지지 않는다**
9. 상한을 넘는 첨부에서 **본문은 살아남고 원본이 격리된다**
10. R2 업로드가 실패해도 **본문이 저장된다**
11. 서명 검증이 그대로 걸린다 — 다른 키면 401이고 아무것도 저장되지 않는다
12. **열려 있는 화면이 갱신된다.** 웹훅 요청으로 확인해라
13. `sms:received`와 발송 리포트 경로가 **깨지지 않는다**
14. `python3 .claude/scripts/dead-exports.py` · `positional-consts.py` ·
    `unwired-routes.py` · `routes.py` 통과
15. 커밋하고 `origin/hoddukzoa12/g12-gateway-mms-inbound`에 푸시한 뒤 해시를
    보고해라. **배포하지 마라.**

## 막히면

범위가 애매하면 혼자 판단하지 말고 `ask`로 물어라. 답을 기다리며 멈추지 말고
막힌 지점만 남기고 나머지를 진행해라. 10분 내 답이 없으면 `escalation`을 올려라.
