## 목표

**LGU+ 호출을 사무실 터널로 보낸다.** 그리고 그 터널을 우리만 쓸 수 있게
Cloudflare Access 서비스 토큰을 붙인다.

## 왜

LGU+ 운영 API가 **발신 IP 허용목록**을 강제하는데 Cloudflare Workers는 고정
egress IP가 없다. 사무실 서버의 `cloudflared` 터널이 이미 서 있고, 사무실 IP는
LGU+에 등록돼 있다.

내가 실제로 확인한 상태다:

```
lgu-auth.rich-group.kr   → 403 Cloudflare Access   (DNS·터널·Access 모두 동작)
lgu-send.rich-group.kr   → 403
lgu-file.rich-group.kr   → 403
```

`403`이 정상이다 — 서비스 토큰이 없어서 막힌 것이다. **워커가 그 토큰을 실어
보내야 통과한다.**

## 바꿀 것

### 1. `wrangler.jsonc` — 세 호스트를 터널 주소로

| 키 | 지금 | 바꿀 값 |
|---|---|---|
| `LGU_AUTH_HOST` | `api.msghub.uplus.co.kr` | `lgu-auth.rich-group.kr` |
| `LGU_SEND_HOST` | `api-send.msghub.uplus.co.kr` | `lgu-send.rich-group.kr` |
| `LGU_CONTENT_HOST` | `mnt-api.msghub.uplus.co.kr` | `lgu-file.rich-group.kr` |

**각 줄에 주석으로 실제 목적지를 적어라.** 예: `// → api.msghub.uplus.co.kr`
그 매핑은 사무실 서버의 `cloudflared` 설정에 있어서, 여기 안 적으면 다음 사람이
이 주소가 무엇인지 알 길이 없다.

`LGU_ENV`는 `production` 그대로 둔다.

`secrets.required`에 아래 두 개를 더한다.

### 2. Access 서비스 토큰 헤더

LGU+로 나가는 **모든** 요청에 두 헤더가 필요하다:

```
CF-Access-Client-Id:     <시크릿>
CF-Access-Client-Secret: <시크릿>
```

시크릿 이름은 네가 정해라. 위 헤더 이름과 대응되게 지어라.

**한 곳에서만 붙여라.** `worker/lgu/http.ts`가 이 저장소의 공통 fetch 지점이다.
직접 읽고, 인증·발송·콘텐츠 세 경로가 **전부 그곳을 지나는지 확인해라.**
지나지 않는 경로가 있으면 `ask`로 알려라 — 하나라도 빠지면 그 기능만 403이 된다.

**시크릿이 설정되지 않았으면 헤더를 붙이지 마라.** 로컬 개발과 테스트는
터널 없이 도는데, 빈 문자열 헤더를 보내면 그쪽이 깨진다.

### 3. `.dev.vars.example`

새 시크릿 두 개를 **그 파일의 기존 서술 방식대로** 추가해라 —
누가 발급하는가 / 어디서 구하는가 / 없으면 무엇이 안 되는가.

발급처는 **Cloudflare Zero Trust > Access > 서비스 토큰**이고,
**Secret은 생성 시점에 한 번만 보인다**는 것을 적어라.

## 반드시 지킬 것

- **실제 시크릿 값을 만들거나 커밋하지 마라.** 자리표시자만이다
- `.dev.vars`(실제 파일)를 읽지도 쓰지도 마라
- **배포하지 마라.** `wrangler deploy`도 `secret put`도 하지 마라
- `DEV_LOGIN_ENABLED`는 `"false"`
- `worker/lgu/` 외의 `worker/`·`src/`·`shared/`·`migrations/`를 건드리지 마라

## 수용 기준

1. `npm run check` 통과 — 기존 테스트가 **하나도 깨지지 않는다**
2. 세 호스트가 터널 주소이고, 각 줄에 목적지 주석이 있다
3. **시크릿이 있으면 두 헤더가 실제로 나간다** — 목 fetch로 헤더를 확인하는
   테스트를 새로 써라. "코드에 있다"가 아니라 **요청에 실렸는지**를 봐라
4. **시크릿이 없으면 헤더가 안 나간다** — 이것도 테스트로 확인해라
5. 인증·발송·콘텐츠 **세 경로 모두** 헤더가 붙는다. 셋 다 확인해라
6. `secrets.required`에 두 이름이 있다
7. `.dev.vars.example`에 두 항목이 한국어 설명과 함께 있다
8. `npx wrangler deploy --dry-run` 성공 (**dry-run이다**)
9. `git diff`에 실제 시크릿 값이 없다

## 만들지 말 것

- 배포·시크릿 주입
- 재시도·타임아웃 정책 변경 — 지금 것을 그대로 둔다
- 새 추상화. **헤더 두 개를 붙이는 일이다**
