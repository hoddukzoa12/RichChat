## 목표

**LGU+ 연동을 QA에서 운영으로 바꾼다.** `wrangler.jsonc`의 `vars` 4개뿐이다.

## 왜 — 추측이 아니라 실측이다

운영에 배포된 워커가 첨부를 못 받고 답장도 못 보낸다. 실제 자격증명으로
두 환경에 인증을 걸어 원인을 확인했다:

```
POST https://api.msghub-qa.uplus.co.kr/auth/v1/{randomStr}
  → 401 {"code":"20000","message":"미발급된 API 키"}

POST https://api.msghub.uplus.co.kr/auth/v1/{randomStr}
  → 401 {"code":"29025","message":"허용되지 않는 IP","data":"ip(req)=…"}
```

**우리 API 키는 운영 키인데 설정이 QA 호스트를 가리킨다.** QA는 이 키를
모르므로 토큰 발급이 매번 실패하고, 첨부는 영원히 `대기`에 남는다.

운영 호스트는 키를 알아본다 — IP 허용목록에서 막혔을 뿐이다. **그 IP 문제는
이 슬라이스 범위가 아니다.** LGU+와 협의 중이며, 호스트 교체는 어느 결론이든
필요하다.

## 바꿀 값

`wrangler.jsonc`의 `vars`. **DNS로 세 호스트 모두 실재를 확인했다.**

| 키 | 지금 | 바꿀 값 |
|---|---|---|
| `LGU_ENV` | `qa` | `production` |
| `LGU_AUTH_HOST` | `api.msghub-qa.uplus.co.kr` | `api.msghub.uplus.co.kr` |
| `LGU_SEND_HOST` | `api-send.msghub-qa.uplus.co.kr` | `api-send.msghub.uplus.co.kr` |
| `LGU_CONTENT_HOST` | `mnt-api.msghub-qa.uplus.co.kr` | `mnt-api.msghub.uplus.co.kr` |

`LGU_ENV`가 코드 분기에 쓰이는지 **먼저 읽고 확인해라.** 표시용 라벨일 뿐이라고
알고 있지만 내 말을 믿지 말고 `grep`으로 직접 봐라. 분기가 있으면 값을 바꾸기
전에 `ask`로 알려라.

## 로컬 개발 파일은 건드리지 마라

`.dev.vars`는 gitignore 대상이고 실제 시크릿이 들어 있다. **읽지도 쓰지도 마라.**

`.dev.vars.example`의 주석에 QA 호스트 예시가 있다면 그건 그대로 둔다 —
그 파일은 "어디서 값을 구하는가"를 설명하지 특정 환경을 지정하지 않는다.

## 반드시 지킬 것

- **`vars`의 다른 키를 건드리지 마라.** 특히 `DEV_LOGIN_ENABLED`는 `"false"`다
- **시크릿을 `vars`에 넣지 마라**
- `compatibility_date`를 올리지 마라
- **배포하지 마라.** `wrangler deploy`도 마이그레이션 적용도 하지 마라.
  그건 내가 사용자 확인 아래 한다
- `worker/`·`src/`·`shared/`·`migrations/`를 수정하지 마라

## 수용 기준

1. `npm run check` 통과 (407개)
2. `grep -c 'msghub-qa' wrangler.jsonc`가 **0**
3. 위 표의 네 값이 정확히 그대로 들어 있다
4. `DEV_LOGIN_ENABLED`가 여전히 `"false"`
5. `npx wrangler deploy --dry-run`이 오류 없이 끝난다 (**dry-run이다**)
6. `worker-configuration.d.ts`가 필요하면 `npm run types`로 재생성해 커밋에 포함
7. `git diff`에 `wrangler.jsonc`(및 생성물) 외의 파일이 없다
