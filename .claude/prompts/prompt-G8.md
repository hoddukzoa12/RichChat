# G8 — 서명키 배포 경로 철거, 기기별 키를 정본으로

`AGENTS.md`를 먼저 읽고 그 원칙을 따라라.

## 왜 걷어내는가 — 추측이 아니라 확인된 사실이다

서명키를 서버로 밀어 넣는 것이 **업스트림에서 불가능하다.**

- `client-go v1.14.2` (서버가 `go.mod`에 고정한 버전):
  `SigningKey *string \`json:"signing_key,omitempty" validate:"omitempty,isdefault"\``
  `isdefault`는 **값이 비어 있어야 통과**한다는 뜻이다.
- 서버의 `PATCH`·`PUT /3rdparty/v1/settings`가 둘 다 이 구조체로 본문을 검증하고,
  실패하면 400을 낸다 (`handlers/settings/3rdparty.go`).
- 모바일 API의 settings는 `get`만 등록돼 있다. 쓰기 경로가 없다.
- **운영에서 실제로 400을 받았다.**

그래서 사용자가 **기기별 키**로 결정했다. 서명키는 각 업무폰 앱에서
**설정 → Webhooks → Signing Key**에 직접 넣는다.

앱이 서버 설정을 동기화해도 이 값은 덮이지 않는다 — `import()`가 응답에
들어 있는 키만 순회하는데 서버는 `signing_key`를 저장하지 못한다.

## 무엇을 하는가

**죽은 배포 경로를 끝에서 끝까지 걷어내고**, 대신 화면과 문서가 앱에서
넣으라고 말하게 한다.

지울 것:

- `worker/gateway/admin.ts` — `deploySigningKey` (인터페이스와 구현 모두)
- `worker/gateway/signing-keys.ts` — `signingKeyDeployTarget`,
  `SigningKeyDeployTarget`, `SigningKeyDeployBlock`
- `worker/routes/office.ts` — `POST /api/office/phones/signing-key` 라우트,
  `SIGNING_KEY_DEPLOYED_MESSAGE`, `SIGNING_KEY_DEPLOY_BLOCKED_MESSAGE`,
  `SIGNING_KEY_FORMAT_HINT`
- `shared/wire/office.ts` — `OfficePhoneSigningKeyDeployResponse`
- `src/api/endpoints/office.ts` — 해당 엔드포인트 함수
- `src/components/OfficePhonesCard.tsx` — 배포 버튼과 그 상태 처리
- 위를 검증하던 테스트

**남길 것:**

- `parseSigningKeys`는 **두 형식을 계속 지원한다.** 운영 시크릿이 공통
  형식(`{"default":…}`)에서 기기별로 넘어가는 중이라 둘 다 검증돼야 한다.
- 업무폰 카드의 **서명키 상태 표시(설정됨/미설정/확인 불가/해당 없음)** 는 그대로 둔다.
  관리자가 어느 폰이 빠졌는지 봐야 한다.
- 등록 코드 발급, 미등록 기기 목록은 건드리지 마라.

## 화면에 넣을 것

배포 버튼이 있던 자리에 **무엇을 해야 하는지** 남겨라. 버튼만 지우면
관리자는 서명키를 어디서 넣는지 알 방법이 없다.

문구에 반드시 포함할 것 — 앱 경로(**설정 → Webhooks → Signing Key**)와,
**Worker 시크릿 `SMS_GATEWAY_SIGNING_KEYS`의 같은 기기 항목에 같은 값**을
넣어야 한다는 사실. 두 곳이 맞아야 수신이 된다.

문구는 네가 다듬어라. 원본 디자인에 없던 자리이므로 카드의 기존 톤을 따라라.

## 건드리지 마라

`worker/routes/hooks-*.ts`, `worker/inbound-message.ts`, `worker/gateway/send.ts`,
`migrations/`, `wrangler.jsonc`.

**`AGENTS.md`·`CLAUDE.md`·계획서를 고치지 마라.** 고쳐야 할 것이 보이면
보고에 적어라.

## 수용 기준

1. `npm run check` 통과
2. **기기별 형식으로 수신 웹훅이 검증된다** — `{"<deviceId>":"<키>"}`로 서명한
   `sms:received`가 저장되고, 다른 키로 서명하면 401이다
3. **공통 형식도 계속 검증된다** — `{"default":"<키>"}`로 임의 기기의 웹훅이 통과한다
4. `POST /api/office/phones/signing-key`가 **더 이상 등록되지 않는다.**
   라우트 목록을 실제로 조회해 확인해라 — 파일에서 지웠다는 것만으로는 부족하다
5. 프런트에서 그 경로를 호출하는 코드가 **한 군데도 남지 않는다**
6. 업무폰 카드에서 **폰별 서명키 상태가 그대로 보이고**, 앱에서 넣으라는
   안내와 경로가 보인다. 렌더한 결과로 확인해라
7. **키 값이 응답·로그·화면 어디에도 나오지 않는다.** 기존 검증을 유지해라
8. `.dev.vars.example`의 `SMS_GATEWAY_SIGNING_KEYS` 주석을 개정한다 —
   기기별 형식이 기본이고, **서버로 배포할 수 없는 이유**(위 근거를 한 줄로),
   앱 입력 경로, 회전 절차(폰마다 입력해야 하므로 대수만큼 손이 간다)를 적어라.
   지금 남아 있는 "화면에서 서명키 배포를 실행한다"는 문장은 **거짓이 된다**
9. `python3 .claude/scripts/dead-exports.py` · `positional-consts.py` ·
   `unwired-routes.py` 전부 통과
10. 커밋하고 `origin/hoddukzoa12/g8-signing-key-manual`에 푸시한 뒤 해시를 보고해라.
    **배포하지 마라.**

## 막히면

범위가 애매하면 혼자 판단하지 말고 `ask`로 물어라. 답을 기다리며 멈추지 말고
막힌 지점만 남기고 나머지를 진행해라. 10분 내 답이 없으면 `escalation`을 올려라.
