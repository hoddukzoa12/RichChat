## 목표

`wrangler.jsonc`의 `LGU_ENV`를 `"local"` → `"qa"`로 바꾼다. **한 줄이다.**

## 왜

`LGU_ENV`는 `/api/health` 응답의 `env` 필드로만 쓰인다 (`worker/routes/health.ts:11`).
기능에는 영향이 없지만 **배포 검증에 쓰는 진단 값**이다.

지금 운영에 배포하면 `chat.rich-group.kr/api/health`가 `{"ok":true,"env":"local"}`을
반환한다. "이게 로컬인가?" 하고 헷갈린다.

`LGU_*_HOST`가 전부 `*-qa.uplus.co.kr`이므로 **LGU+ 연동 환경은 QA다.**
`qa`가 사실이다.

## 반드시 지킬 것

**그 한 줄만 바꿔라.** 라우트·`workers_dev`·`observability`·`compatibility_date`·
D1·R2·시크릿 선언을 건드리지 마라. 방금 검증한 설정이다.

**`DEV_LOGIN_ENABLED`는 `"false"` 그대로다.**

로컬 개발은 `.dev.vars`가 `LGU_ENV=local`로 덮으므로 영향받지 않는다.
`.dev.vars`를 건드리지 마라.

배포 명령을 실행하지 마라.

## 수용 기준

1. `npm run check` 통과 (398개 그대로)
2. `wrangler.jsonc`의 `LGU_ENV`가 `"qa"`
3. `git diff`가 **그 한 줄뿐**이다 (생성물 제외)
4. `npx wrangler deploy --dry-run`이 오류 없이 끝나고 `env.LGU_ENV ("qa")`로 표시된다
