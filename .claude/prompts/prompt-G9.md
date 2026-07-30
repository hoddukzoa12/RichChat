# G9 — 업무폰 서명키를 D1로 옮기고 화면에서 발급한다

`AGENTS.md`를 먼저 읽고 그 원칙을 따라라.

## 왜

지금 서명키는 Worker 시크릿(`SMS_GATEWAY_SIGNING_KEYS`)에 JSON으로 산다.
**워커는 자기 시크릿을 쓸 수 없다.** 그래서 업무폰을 한 대 붙일 때마다
개발자가 `wrangler secret put`으로 JSON을 손으로 편집해야 한다.
사무실에서 못 한다. 폰이 9대로 늘면 무너진다.

게이트웨이 관리 API로 키를 밀어 넣는 경로는 **업스트림이 막았다**
(`client-go`가 `signing_key`에 빈 값만 허용 → 400). G8에서 그 경로를 걷어냈다.

그래서 **키를 D1에 두고 화면에서 발급**한다.

## 무엇을 하는가

### 스키마

`migrations/0010_office_channel_signing_keys.sql`

업무폰은 이미 `office_channels`에 `device_id`를 갖는다(`0008`). 키를 그 행에 붙여라.
**새 테이블을 만들지 마라.** 컬럼은 NULL 허용 — 아직 발급 전인 폰이 있다.

`0009`의 교훈을 그대로 지켜라: **테이블을 재생성하지 마라.**
`conversations`를 다시 만들면 `messages`의 `ON DELETE CASCADE`가 돌아 수신
이력이 사라진다. `ALTER TABLE ... ADD COLUMN`으로 끝내라.

### 발급 라우트

`POST /api/office/phones/:id/signing-key` (경로는 네가 정하되 **기존 라우트와
겹치지 않는지** `python3 .claude/scripts/routes.py`로 확인해라)

- **관리자만.** 비관리자는 403이고 D1이 바뀌지 않는다
- `crypto.getRandomValues`로 **128비트 이상** 난수를 만들어 hex로 저장한다.
  `Math.random`을 쓰지 마라
- 응답에 **평문을 1회만** 담고 `Cache-Control: no-store`를 붙인다
- **그 외 어떤 응답·로그·이벤트 payload에도 키가 나오면 안 된다**
- 재발급은 덮어쓴다. 이전 키는 그 순간 무효다

### 검증 경로

수신 웹훅의 서명 검증이 **시크릿이 아니라 D1 조회**로 바뀐다.
지금은 `worker/index.ts`의 `smsGatewayWebhookEnv`가
`legacySigningKeysForWebhook(env.SMS_GATEWAY_SIGNING_KEYS, deviceId)`로 만든다.

`deviceId`에 해당하는 `office_channels` 행이 없거나 `signing_key`가 NULL이면
**401**이다. 조용히 통과시키지 마라.

### 시크릿 철거

`SMS_GATEWAY_SIGNING_KEYS`를 **코드·`wrangler.jsonc`의 `secrets.required`·
`.dev.vars.example`에서 전부 걷어내라.** 폴백으로 남기지 마라 —
같은 사실이 두 곳에 살면 어느 쪽이 이기는지 아무도 모른다.

`worker/gateway/signing-keys.ts`의 JSON 파서(`parseSigningKeys`,
`legacySigningKeysForWebhook`, `signingKeyForDevice`)는 **쓰이지 않게 되면
지워라.** 빈 스텁이나 죽은 export를 남기지 마라.

### 화면

업무폰 카드에서 폰마다 **[서명키 발급]**을 누를 수 있어야 한다.

- 발급하면 평문을 보여주고 **복사**할 수 있어야 한다. 닫으면 다시 못 본다는 것을
  화면이 말해야 한다
- 앱에 넣는 경로(**설정 → Webhooks → Signing Key**)를 함께 보여줘라
- **재발급은 그 폰의 수신을 즉시 끊는다.** 누르기 전에 경고해라
- 폰별 서명키 상태(설정됨/미설정) 표시는 유지한다. 이제 D1에서 온다

G8이 넣은 "앱에서 직접 입력하라"는 안내는 **발급 흐름에 맞게 고쳐라.**
이제 값을 우리가 만들어 준다.

## 건드리지 마라

`worker/routes/hooks-mo.ts`·`hooks-report.ts`, `worker/lgu/`,
`worker/inbound-message.ts`의 수신 파이프라인 로직.

**`AGENTS.md`·`CLAUDE.md`·계획서를 고치지 마라.** 고쳐야 할 것이 보이면
보고에 적어라.

## 수용 기준

부품이 아니라 **끝에서 끝까지** 확인해라.

1. `npm run check` 통과
2. **발급한 키로 서명한 실제 `sms:received` 웹훅이 저장된다.** 함수를 직접
   부르지 말고 라우트로 요청을 보내 메시지 행을 확인해라
3. **다른 키로 서명하면 401**
4. **키를 발급하지 않은 기기의 웹훅은 401**
5. **재발급하면 이전 키가 즉시 401**이 된다. 같은 요청을 재발급 전후로 보내 확인해라
6. 발급 응답에 `Cache-Control: no-store`가 붙고 평문이 1회 나온다
7. **평문이 발급 응답 외에 어디에도 없다** — 폰 목록·상세·`events` payload·로그를
   실제로 조회해 확인해라
8. 비관리자는 403이고 D1이 바뀌지 않는다
9. 마이그레이션이 **기존 데이터를 지우지 않는다.** 적용 전후로 `messages`와
   `conversations` 행 수가 같은지 확인해라
10. `SMS_GATEWAY_SIGNING_KEYS`가 저장소 어디에도 남지 않는다
    (`grep -rn SMS_GATEWAY_SIGNING_KEYS`가 0건)
11. 화면에서 발급 → 평문 표시 → 상태가 `설정됨`으로 바뀌는 것을 렌더로 확인해라
12. `python3 .claude/scripts/dead-exports.py` · `positional-consts.py` ·
    `unwired-routes.py` · `routes.py` 전부 통과
13. 커밋하고 `origin/hoddukzoa12/g9-signing-key-d1`에 푸시한 뒤 해시를 보고해라.
    **배포하지 마라.**

## 막히면

범위가 애매하면 혼자 판단하지 말고 `ask`로 물어라. 답을 기다리며 멈추지 말고
막힌 지점만 남기고 나머지를 진행해라. 10분 내 답이 없으면 `escalation`을 올려라.
