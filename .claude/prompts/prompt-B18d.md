<!-- api-conventions -->

## 목표

**MMS(사진) 수신이 거부되고 있다.** 운영에서 고객이 사진을 보내면 격리된다.

## 실제로 온 페이로드 (운영 `mo_failures`에서 그대로)

```json
{"moKey":"l0sSZPvGii.6gLlQs","moNumber":"18771239","moType":"MMSMO",
 "moCallback":"01077955363","productCode":"MMSMO","moTitle":"제목없음",
 "moMsg":null,
 "telco":"KT","contentCnt":1,
 "contentInfoLst":[{"contentName":"FL9yvTRGkR_0.jpg","contentSize":"94254",
                    "contentExt":"jpg",
                    "contentUrl":"https://df25hb5tuwkue.cloudfront.net/mmsmo/null/null/2026/07/29/FL9yvTRGkR_0.jpg"}],
 "moRecvDt":"2026-07-29T10:46:12"}
```

오류: `PayloadValidationError: moMsg 값이 올바르지 않습니다.`

## 문서·가정과 다른 점

| 필드 | 우리 가정 | 실제 |
|---|---|---|
| `moMsg` | 항상 문자열 | **`null`** — 사진만 보내면 본문이 없다 |
| `contentSize` | 숫자 | **문자열 `"94254"`** |

**`moMsg: null`은 정상이다.** 고객이 사진만 보내면 본문이 없다. 거부하면
사진 문의를 전부 잃는다.

`messages.body`가 `NOT NULL`이므로 **빈 문자열로 저장해라.** 화면은 첨부만
보여주면 된다. `moTitle`("제목없음")을 본문으로 쓰지 마라 — LGU+가 넣은
자동 문구지 고객이 쓴 게 아니다.

`contentSize`는 **문자열도 숫자도 받아** 정수로 정규화해라.
`message_attachments.byte_size`가 INTEGER다.

## 지금 이 순간에도 놓치고 있을 것

`contentUrl`의 경로에 `null`이 두 번 들어 있다 —
`/mmsmo/null/null/2026/07/29/…`. LGU+ 쪽 사정이니 그대로 두되,
**우리가 이 URL을 파싱하거나 신뢰하지 마라.**

**다른 필드도 `null`이 올 수 있다고 보고 방어해라.** `moTitle`은 이미
`null`로 온 적이 있다. 문서에 없는 필드(`productCode`)도 온다.
**필수로 요구할 것은 최소로 줄여라** — 없으면 메시지를 저장조차 못 하는 것만
필수다 (`moKey`·`moType`·`moCallback`·`moRecvDt` 정도).

무엇을 필수로 남길지는 네가 판단하되 **근거를 보고에 적어라.**

## 빈 페이로드

```json
{"moCallback":"","productCode":"","moTitle":"","contentCnt":"",
 "telco":"","moRecvDt":"","moType":"","moNumber":"","moMsg":"","moKey":""}
```

LGU+ 웹훅 등록 시의 검증 핑으로 보인다. 지금 격리되는데 `10000`을 반환하므로
트래픽은 막지 않는다. **그대로 둘지 정상 응답으로 받아넘길지 네가 판단해라.**

## 반드시 지킬 것

**기존 동작을 깨뜨리지 마라.** 지금 400개 테스트가 통과한다.
SMS 경로·멱등·순서·커밋 우선·독약 분류를 건드리지 마라.

첨부 메타데이터는 **동기 커밋**하고 바이너리는 X4의 스케줄이 받아간다.
그 경계를 바꾸지 마라.

## 수용 기준

1. `npm run check` 통과 (400개 이상)
2. **위 실제 MMS 페이로드를 그대로 넣으면 `10000`이 나오고 메시지가 저장된다.**
   그 JSON을 테스트에 그대로 넣어라
3. `moMsg: null` → `body`가 빈 문자열. `moTitle`이 본문으로 안 들어간다
4. **`message_attachments` 행이 생긴다** — 파일명 `FL9yvTRGkR_0.jpg`,
   `byte_size` 94254(정수), `download_status` 대기
5. `contentSize`가 문자열이든 숫자든 정수로 저장된다
6. `moMsg`가 정상 문자열인 SMS → 지금처럼 동작
7. `moTitle: null` → 오류 아님
8. 첨부 2개 이상인 페이로드 → 행 2개, `content_index` 0·1
9. 필수 필드 판단 근거가 보고에 있다
10. 빈 페이로드 처리 판단과 근거가 보고에 있다
