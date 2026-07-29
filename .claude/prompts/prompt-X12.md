## 목표

**LGU+ 인증 응답 파싱을 실제 응답에 맞춘다.** `worker/lgu/token.ts` 한 파일이다.

## 실측한 응답

운영 LGU+에 실제로 인증을 걸어 받은 것이다. 문서가 아니라 **실제 트래픽**이다.

```
HTTP 200
{ code: "10000", message: "성공",
  data: { token: <240자>, refreshToken: <241자> } }
```

## 지금 코드가 틀렸다

`worker/lgu/token.ts:138-141`

```ts
interface AuthResponse {
  code: string
  accessToken?: unknown
}
```

그리고 220행이 `response.accessToken`이 문자열인지 검사한다. 실제 응답에는
**그 필드가 없다.** `fetchLguJson`은 껍질을 벗기지 않고 본문을 그대로 준다.

**그래서 인증이 100% 실패한다.** 발송·리포트 보정·첨부 재조회가 전부 막힌다.
테스트가 전부 통과하는데도 그렇다 — 목이 문서 기준으로 쓰였기 때문이다.

## 고칠 것

토큰을 **`data.token`**에서 읽어라.

`data`가 없거나 `token`이 문자열이 아니면 지금처럼 오류를 던져라.
**모양이 또 다를 수 있으니 방어는 유지해라.**

### `refreshToken`을 쓰지 마라

실제로 응답에 온다. **저장도 사용도 하지 마라.**
`AGENTS.md`에 이유가 적혀 있다 — 발급 IP에 묶이는데 Workers는 고정 egress IP를
보장하지 않아 다른 colo에서 간헐적으로 실패한다. 원인 찾기 어려운 버그가 된다.

`grep -c refresh worker/lgu/`가 0이어야 한다는 기존 기준을 그대로 지켜라.

## 테스트를 실제 모양으로 바꿔라

**이게 이 슬라이스의 핵심이다.**

지금 목이 `{ code, accessToken }`을 돌려준다. 그것이 문서의 사본이고 틀렸다.
**목을 위 실측 모양으로 바꿔라.** 안 바꾸면 테스트는 통과하는데 운영은 계속 죽는다.

같은 실수가 이 저장소에서 **여섯 번** 났다. `AGENTS.md`의 "외부 API는 문서가
아니라 실제 응답이 정본이다"가 그래서 있다.

**주석으로 실측값임을 남겨라.** 다음 사람이 문서를 보고 되돌리지 않도록:

```ts
// 운영 실측: { code, message, data: { token, refreshToken } }
// 문서의 최상위 accessToken 은 실제와 다르다.
```

## 반드시 지킬 것

- `worker/lgu/token.ts`와 그 테스트만 건드려라
- 리스·캐시·재인증 로직을 바꾸지 마라. **파싱만이다**
- 실제 토큰 값을 커밋하지 마라
- 배포하지 마라

## 수용 기준

1. `npm run check` 통과
2. 목이 **실측 모양**을 돌려주고, 그 목으로 토큰이 정상 추출된다
3. `data`가 없거나 `data.token`이 문자열이 아니면 **오류를 던진다** (테스트로 확인)
4. `grep -rn "accessToken" worker/lgu/token.ts`에 **응답 파싱용 최상위 접근이 없다**
   (내부 캐시 타입 이름으로 쓰는 것은 무방하다)
5. `grep -c refresh worker/lgu/` = 0
6. 리스·캐시 관련 기존 테스트가 전부 통과한다

커밋하고 `origin/hoddukzoa12/x12-auth-parse`에 푸시한 뒤 해시를 보고해라.
