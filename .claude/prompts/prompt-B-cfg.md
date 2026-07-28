## 목표

**설정 바인딩만 미리 선언한다.** 로직은 하나도 만들지 않는다.

`wrangler.jsonc`는 공유 자원이라 여러 슬라이스가 동시에 건드리면 충돌한다.
곧 9개를 병렬로 내보낼 참이라, **필요한 바인딩을 먼저 다 뚫어놓고** 그 뒤로는
아무도 이 파일을 안 만지게 하려는 것이다.

## 추가할 것

### 시크릿 (`secrets.required`)

지금 `LGU_API_KEY`·`LGU_API_PASSWORD` 둘이 있다. 여기에 더한다.

| 이름 | 쓰는 곳 | 용도 |
|---|---|---|
| `LGU_MO_WEBHOOK_SECRET` | B18 | MO 수신 웹훅 경로에 박히는 값 |
| `LGU_REPORT_WEBHOOK_SECRET` | B19 | 발송 리포트 웹훅 경로 |
| `WORKS_CLIENT_SECRET` | B5 | 네이버웍스 OIDC 클라이언트 시크릿 |

**웹훅 시크릿 두 개를 하나로 합치지 마라.** 하나가 새면 둘 다 갈아야 한다.

### 변수 (`vars`)

| 이름 | 값 | 비고 |
|---|---|---|
| `WORKS_CLIENT_ID` | 빈 문자열 | 비밀이 아니다. 인가 URL에 그대로 실린다 |
| `WORKS_ISSUER` | 네이버웍스 OIDC issuer | 아래 확인 지침을 봐라 |

**`WORKS_ISSUER`를 추측해서 쓰지 마라.** 네이버웍스 개발자 문서에서 실제
issuer와 discovery 문서 경로를 확인해 정확한 값을 넣어라. 확인이 안 되면
빈 문자열로 두고 **보고에 그 사실을 적어라.** 틀린 값이 들어가면 B5가 그걸
믿고 구현한다.

리다이렉트 URI는 **변수로 만들지 마라.** 요청 출처에서 파생하는 편이 배포
환경마다 값을 관리하는 것보다 안전하다 — 그 판단은 B5가 한다.

## 반드시 지킬 것

**시크릿은 `vars`에 넣지 마라.** `vars`는 대시보드에 평문으로 보이고
빌드 산출물에 남는다. `secrets.required`에만 이름을 선언한다.

`DEV_LOGIN_ENABLED`를 포함해 **기존 항목은 값도 이름도 건드리지 마라.**
방금 인증 슬라이스가 병합된 참이다.

`npm run types`로 `worker-configuration.d.ts`를 재생성하고 **커밋에 포함해라.**
생성물이지만 저장소에 들어 있어야 다른 슬라이스가 타입을 본다.

## 수용 기준

1. `npm run check` 통과 (**95개 테스트 그대로.** 줄면 뭔가 깨진 것이다)
2. `worker-configuration.d.ts`에 새 이름 5개가 전부 보인다
3. `vars`에 시크릿 이름이 **하나도 없다**
4. 기존 5개 `vars` 값이 그대로다 — 특히 `DEV_LOGIN_ENABLED`가 `"false"`
5. 로컬 개발용 시크릿 값을 넣어야 한다면 `.dev.vars`를 쓰고
   **`.gitignore`에 있는지 확인해라.** 없으면 추가해라.
   실제 시크릿 값을 커밋하면 안 된다

## 만들지 말 것

- 라우트, 핸들러, OIDC 로직, 웹훅 로직 — **전부 다른 슬라이스 소유다**
- `worker/`·`src/`·`shared/`·`migrations/` 아래 어떤 파일도 수정
- 테스트 추가 — 이 슬라이스는 선언만 한다

`wrangler.jsonc`, `worker-configuration.d.ts`, 필요하면 `.gitignore`.
**그 셋이 전부다.**
