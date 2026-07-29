## 목표

`wrangler.jsonc`의 `vars`에서 **비어 있는 네이버웍스 공개 식별자 둘을 채운다.**

```
WORKS_CLIENT_ID = ''     ← 채운다
WORKS_TENANT_ID = ''     ← 채운다
```

둘 다 **비밀이 아니다.** Client ID는 인가 URL에 그대로 실려 나가고,
테넌트 ID는 공개 discovery 경로에 들어간다. 그래서 시크릿이 아니라 `vars`다.

## 값을 어디서 읽나

**메인 작업 디렉터리의 `.dev.vars`에 실제 값이 있다:**

```
/Users/hoddukzoa/orca/projects/RichChat/.dev.vars
```

거기서 `WORKS_CLIENT_ID`와 `WORKS_TENANT_ID` 두 줄을 읽어 그대로 옮겨라.
**그 파일을 수정하지 마라. 읽기만 한다.**

네 워크트리에는 `.dev.vars`가 없다 (gitignore라 복사되지 않는다). 위 절대
경로로 읽어라.

## 반드시 지킬 것

**그 두 줄만 바꿔라.**

- `WORKS_CLIENT_SECRET`은 **시크릿이라 `vars`에 넣지 마라.** 이미
  `wrangler secret put`으로 운영에 등록돼 있다
- `DEV_LOGIN_ENABLED`는 `"false"` 그대로
- `LGU_ENV`는 `"qa"` 그대로
- 라우트·`workers_dev`·`observability`·D1·R2·`secrets.required`를 건드리지 마라

`npm run types`로 `worker-configuration.d.ts`를 재생성해라. 이 둘은 리터럴
타입이라 **생성물이 바뀌는 것이 정상**이다. 손으로 고치지 말고 명령으로 해라.

## 수용 기준

1. `npm run check` 통과 (398개)
2. `wrangler.jsonc`의 두 값이 `.dev.vars`와 **글자 그대로 일치**한다
3. `WORKS_CLIENT_SECRET`이 `vars`에 **없다**
4. `DEV_LOGIN_ENABLED`가 `"false"`, `LGU_ENV`가 `"qa"`
5. `worker-configuration.d.ts`가 재생성 결과와 일치한다
6. `npx wrangler deploy --dry-run`이 통과하고 두 값이 채워져 표시된다
7. `git diff`가 `wrangler.jsonc`·`worker-configuration.d.ts` 둘뿐이다

## 만들지 말 것

- 실제 배포
- `.dev.vars` 수정
- `worker/`·`src/`·`shared/`·`migrations/` 수정
