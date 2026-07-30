# G10 — 크론이 업무폰 발송을 LGU+에 묻지 않게 한다

`AGENTS.md`를 먼저 읽고 그 원칙을 따라라.

## 운영 결함이다

업무폰으로 보낸 문자가 **고객에게 정상 도착했는데 화면에는 실패로 뜬다.**
사유는 `LGU+ 결과를 실패로 확정했습니다. (...)`.

원인은 `worker/scheduled.ts:103`의 미확정 메시지 조회다.

```sql
SELECT office_id, client_key, created_at
  FROM messages INDEXED BY ix_messages_pending
 WHERE delivery_status IN ('대기', '접수', '전송중')
   AND client_key IS NOT NULL
```

**어느 경로로 나갔는지를 보지 않는다.** 업무폰(SMS Gateway)으로 보낸 메시지는
LGU+에 존재하지 않으므로, 조회 결과가 실패로 해석돼
`worker/lgu/report.ts:213`의 문구가 붙는다.

**피해가 크다.** 상담원이 실패를 보고 같은 문자를 다시 보내서 **고객이 두 번
받는다.**

## 무엇을 하는가

**LGU+ 보정 대상에서 업무폰 발송을 제외한다.**

업무폰 여부는 대화가 묶인 채널로 판별한다 — `conversations.office_channel_id`가
가리키는 `office_channels` 행에 `device_id`가 있으면 업무폰이다.
`messages`에는 경로를 나타내는 컬럼이 없다.

**판별을 SQL 한 문장 안에서 해라.** 후보를 다 뽑아 애플리케이션에서 거르면
`INDEXED BY ix_messages_pending`의 이점이 사라지고, 업무폰이 늘수록 헛일이 는다.

기존 인덱스로 계획이 무너지지 않는지 확인해라. `INDEXED BY` 힌트가 새 조인과
맞지 않으면 **힌트를 억지로 유지하지 말고** 무엇을 왜 바꿨는지 보고에 적어라.

## 건드리지 마라

`worker/routes/hooks-sms-gateway.ts` — **다른 슬라이스가 같은 파일을 고치는 중이다.**
발송 상태 웹훅(`sms:sent`·`sms:delivered`·`sms:failed`) 처리는 이 슬라이스가 아니다.
그 결과 업무폰 메시지는 당분간 `접수`에 머문다. **그게 의도한 상태다** —
거짓 실패보다 낫다.

`worker/lgu/`·`migrations/`·`wrangler.jsonc`도 건드리지 마라.

**`AGENTS.md`·`CLAUDE.md`·계획서를 고치지 마라.** 고쳐야 할 것이 보이면
보고에 적어라.

## 수용 기준

부품이 아니라 **끝에서 끝까지** 확인해라.

1. `npm run check` 통과
2. **업무폰 채널에 묶인 미확정 메시지가 크론에서 LGU+ 조회 대상이 되지 않는다.**
   LGU+ 클라이언트가 **호출되지 않았음**을 확인해라
3. **LGU+ 채널에 묶인 미확정 메시지는 지금처럼 조회되고 상태가 갱신된다.**
   이 경로를 깨뜨리면 안 된다 — 아직 LGU+를 병행 운영한다
4. 업무폰 메시지의 `delivery_status`가 크론을 돌린 뒤에도 **바뀌지 않는다.**
   `실패`로도 `완료`로도 가지 않는다
5. 대화에 `office_channel_id`가 없는(NULL) 메시지가 있어도 크론이 죽지 않는다.
   어느 쪽으로 분류했는지 근거를 보고에 적어라
6. 첨부 다운로드 등 `scheduled.ts`의 다른 작업이 영향을 받지 않는다
7. `python3 .claude/scripts/dead-exports.py` · `positional-consts.py` ·
   `unwired-routes.py` 통과
8. 커밋하고 `origin/hoddukzoa12/g10-cron-skip-gateway`에 푸시한 뒤 해시를 보고해라.
   **배포하지 마라.**

## 막히면

범위가 애매하면 혼자 판단하지 말고 `ask`로 물어라. 답을 기다리며 멈추지 말고
막힌 지점만 남기고 나머지를 진행해라. 10분 내 답이 없으면 `escalation`을 올려라.
