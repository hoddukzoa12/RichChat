## 목표

**운영 배포 설정을 `wrangler.jsonc`에 넣는다.** 커스텀 도메인 `chat.rich-group.kr`.

배포는 아직 하지 마라. **설정만 넣고 `npm run check`까지가 범위다.**

## 확인된 사실

내가 Cloudflare API로 직접 확인했다. 추측하지 마라.

| | |
|---|---|
| 계정 | `c7cf14083b176990a114b636e62987b9` |
| 존 | `rich-group.kr` (`bb51fcadd668ea06a83e741ecc9ea522`, active) |
| D1 | `richchat` = `486256bf-b4ec-47ca-ae44-5af82de40095` (이미 있음) |
| R2 | `richchat-attachments` (이미 있음) |

**D1·R2 설정은 이미 맞다. 건드리지 마라.**

## 넣을 것

`chat.rich-group.kr`로 요청이 오게 하는 라우트.

**커스텀 도메인 방식을 써라** — Cloudflare가 DNS 레코드와 인증서를 자동으로
만든다. 서브도메인 하나를 워커에 통째로 주는 것이라 이 앱에 맞다.

경로 패턴(`zone_name` + `pattern`) 방식과 헷갈리지 마라. 그건 기존 사이트의
일부 경로만 워커로 보낼 때 쓴다. 우리는 도메인 전체다.

**정확한 키 이름과 모양은 Cloudflare 공식 문서를 확인해서 써라.**
내가 여기 적으면 틀릴 수 있다.

## 함께 확인할 것

### `workers_dev`

커스텀 도메인을 쓰면 `*.workers.dev` 주소도 함께 열릴 수 있다.
**열어둘지 닫을지 판단하고 그 근거를 보고에 적어라.**

닫는 쪽이 안전하다 — 인증이 걸려 있어도 **접근 경로가 둘이면 하나를 잊는다.**
다만 도메인 문제로 막혔을 때 우회 확인 수단이 사라진다는 대가가 있다.

### 관측성

운영에서 오류를 볼 수 없으면 디버깅이 불가능하다. `observability`가 켜져
있는지 확인하고, 없으면 켜라.

### `compatibility_date`

지금 `2026-07-28`이다. 그대로 둬라. **올리지 마라** — 런타임 동작이 바뀌어
검증한 것이 무효가 된다.

## 반드시 지킬 것

**`vars`를 건드리지 마라.** 특히 `DEV_LOGIN_ENABLED`는 `"false"`여야 한다.
운영에서 이게 열리면 누구나 아무 계정으로 로그인한다.

**시크릿을 `vars`에 넣지 마라.** 대시보드에 평문으로 보인다.
`secrets.required`의 5개는 배포 시 `wrangler secret put`으로 넣는다.

`npm run types`로 `worker-configuration.d.ts`를 재생성해 커밋에 포함해라.

**배포 명령을 실행하지 마라.** `wrangler deploy`도 `d1 migrations apply --remote`도
하지 마라. 그건 내가 사용자 확인 아래 한다.

## 수용 기준

1. `npm run check` 통과 (398개 그대로)
2. `wrangler.jsonc`에 `chat.rich-group.kr` 커스텀 도메인 설정이 있다
3. **`DEV_LOGIN_ENABLED`가 `"false"`다**
4. `vars`에 시크릿 이름이 하나도 없다
5. D1 `database_id`와 R2 `bucket_name`이 위 표와 일치한다
6. `compatibility_date`가 `2026-07-28` 그대로다
7. `worker-configuration.d.ts`가 재생성돼 커밋에 있다
8. `npx wrangler deploy --dry-run`이 오류 없이 끝난다
   (**`--dry-run`이다. 실제 배포가 아니다**)
9. `workers_dev` 판단과 근거가 보고에 있다

## 만들지 말 것

- 실제 배포·마이그레이션 적용
- 시크릿 값 생성이나 주입
- `worker/`·`src/`·`shared/`·`migrations/` 수정
- DNS 레코드 직접 생성 — 커스텀 도메인 설정이 알아서 한다
