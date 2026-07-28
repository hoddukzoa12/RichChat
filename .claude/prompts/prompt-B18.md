<!-- api-conventions -->

## 목표

**고객이 보낸 메시지를 받는 경로.** LGU+ 메시지허브가 우리 웹훅으로 POST한다.

`POST /api/hooks/lgu/mo/:secret`

이게 없으면 인박스가 성립하지 않는다. 지금은 프론트엔드의 3.5초 `setTimeout`이
새 메시지 도착을 흉내내고 있다.

## 페이로드

```json
{ "moCnt": 1, "moLst": [{
    "moKey": "1234", "moNumber": "15445367", "moType": "SMSMO",
    "moCallback": "01012345678", "moMsg": "부가세 문의드려요", "telco": "LGU",
    "moRecvDt": "20260728140611", "contentCnt": 0, "contentInfoLst": [] }] }
```

`moCallback`이 **고객 번호**, `moNumber`가 우리 수신번호다.

성공하면 반드시 `{"code":"10000","message":"success"}`를 반환한다.

## 반드시 지킬 것

### 커밋 우선 — ack가 아니다

**D1 커밋이 끝난 뒤에만 `10000`을 반환한다.** 그 외 코드를 주면 LGU+가
재전송하는데 **그게 설계된 재시도 경로다.**

먼저 ack하고 `waitUntil`로 미루면 isolate가 죽을 때 고객 메시지를 잃는다.
응답 전에 미룰 수 있는 건 "무거운 작업"이 아니라 **"내구성과 무관한 작업"**
(실시간 브로드캐스트, 첨부 바이너리 다운로드)뿐이다.

### 멱등 — 재전송은 정상 경로다

같은 `moKey`가 두 번 와도 메시지는 하나여야 한다. `messages.mo_key`에 부분
유니크 인덱스가 이미 있다.

`ON CONFLICT(mo_key) WHERE mo_key IS NOT NULL DO NOTHING`을 써라.
**충돌 타깃의 `WHERE` 절은 필수다** — 부분 인덱스를 타깃으로 쓸 때 빼면
런타임 오류가 난다.

`INSERT OR IGNORE`로 대체하지 마라. NOT NULL·FK·CHECK 위반까지 삼켜서
고객 메시지를 조용히 버린다.

**카운터도 멱등이어야 한다.** `inbound_count` 증가가 재전송 시 두 번
일어나면 안읽음 수가 틀어진다.

### 순서를 믿지 마라

`moLst`를 `moRecvDt` 오름차순으로 정렬한 뒤 처리해라. 그리고 **웹훅 호출
사이의 순서도 뒤바뀐다** — `last_message_at`·`last_message_id` 갱신에
"이 메시지가 실제로 최신일 때만" 가드를 걸어라.

### 삽입 순서 — 순환 FK 때문에 강제된다

`migrations/0001_init.sql` 상단 주석을 읽어라. `conversations`와 `messages`가
서로 참조한다.

새 대화는 `last_message_id=NULL`로 **먼저** INSERT하고, 메시지를 INSERT한
**뒤에** 포인터를 UPDATE한다. **같은 ordered batch 안에서** 해라.
메시지를 먼저 넣거나 대화를 미래 메시지 포인터와 함께 넣으면 FK 오류다.

### 조용히 틀리는 파싱 둘

**`moRecvDt`는 KST `yyyyMMddHHmmss` 문자열이다.** `new Date(s)`는
`Invalid Date`를 반환한다. 필드를 직접 파싱하고 +09:00을 빼야 한다.
결과가 현재로부터 24시간 넘게 벗어나면 로그를 남기고 수신 시각으로
대체해라 — LGU+의 시계는 우리 것이 아니다.

**전화번호는 국내 형식으로 온다.** `01022334455` → E.164로 정규화해서
저장해라. `customers.phone_e164`가 그 형식이다.

`moType`(`SMSMO`·`MMSMO`·`RCSMO`)을 `messages.channel`로 옮길 때는
`Record`로 매핑해라 (`AGENTS.md` §2, switch 금지). **`RCSMO`가 오면
어떻게 할지 판단이 필요하면 `ask`로 물어라** — 스키마의 채널 유니온에
RCS가 없다.

### 첨부

`contentInfoLst`에 `contentName`·`contentSize`·`contentExt`·`contentUrl`이 온다.

**메타데이터는 동기로 커밋하고 바이너리는 미룬다.** `message_attachments`에
`download_status`가 이미 있고, `완료`면 `r2_key`가 있어야 한다는 CHECK가 걸려
있다.

`contentUrl`은 **일회성이고 24시간**짜리다. 저장해두고 나중에 쓰면 실패한다.
LGU+ 보관은 **7일**이므로 그게 복구 예산이다 — 실패하면
`GET /mo/v1/file/{moKey}`로 다시 받을 수 있다. `contentUrl`로는 재시도 못 한다.

바이너리 다운로드와 R2 저장을 이 슬라이스에서 할지, 상태만 남기고 별도
경로로 뺄지는 **네가 판단해라.** 다만 **응답을 늦추지 마라.**

### 독약 격리

영구 불량 항목이 무한 재전송을 유발하면 안 된다. `mo_failures` 테이블이 이미
있다. 같은 `moKey`가 3회 실패하면 격리하고 `10000`을 반환해 나머지 트래픽이
흐르게 해라.

### 시크릿

경로의 `:secret`을 **상수 시간 비교**로 검증해라. 틀리면 404 — 401이나 403은
경로의 존재를 알려준다.

`wrangler.jsonc`에 시크릿 바인딩을 추가하고 `npm run types`로 재생성해라.
**이번 배치에서 `wrangler.jsonc`를 만지는 슬라이스는 너뿐이다.**

### 상태 전이

- 신규 대화 → `미처리`
- **`완료`인 대화에 새 메시지 → `미처리`로 복귀.** 트리아지 표시이므로
  새 문의가 오면 다시 눈에 띄어야 한다
- `처리중`은 그대로 둔다

## 수용 기준

1. `npm run check` 통과
2. **같은 페이로드 2회 POST → 메시지 1건, `inbound_count` 1 증가, 둘 다 `10000`**
3. `moRecvDt` 역순 배열을 넣어도 스레드가 시간순
4. 웹훅을 두 번 나눠 호출하되 두 번째가 더 과거 메시지일 때
   `last_message_id`가 **뒤로 가지 않는다**
5. 신규 번호 → 고객·대화·메시지 각 1건, 대화 상태 `미처리`
6. **`완료` 대화에 수신 → `미처리` 복귀**
7. D1 쓰기가 실패하면 `10000`이 아닌 코드를 반환한다 (재전송 유도)
8. 같은 `moKey`가 3회 실패 → `mo_failures` 기록 + `10000`
9. 잘못된 시크릿 → 404
10. `moRecvDt` 파싱이 KST 기준이다 (경계를 테스트로 명시)
11. 전화번호가 E.164로 저장된다
12. 첨부가 있는 페이로드 → `message_attachments` 행이 생기고
    `download_status`가 대기 상태

## 만들지 말 것

- 발송, 리포트 — 다른 슬라이스 소유
- 실시간 브로드캐스트 — 이벤트 행만 남기면 된다. DO는 다른 슬라이스 소유
- 프론트엔드(`src/`) 수정
- `migrations/` 수정
