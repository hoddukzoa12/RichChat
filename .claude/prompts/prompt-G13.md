# G13 — 한글 조합 중 Enter가 문자를 두 통 보낸다

`AGENTS.md`를 먼저 읽고 그 원칙을 따라라.

## 운영 결함이다

상담원이 `안녕하세요`를 치고 Enter를 누르면 **문자가 두 통 나간다.**
`안녕하세요` 한 통, `요` 한 통. **고객이 두 번 받는다.**

`src/components/ThreadPanel.tsx:546`

```ts
const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  submit()
}
```

한글 IME는 **조합 중**에 Enter를 누르면 브라우저가 keydown을 먼저 던지고
그다음 마지막 글자를 확정한다. 그래서 확정 전 본문으로 한 번 보내고, 남은
조합 글자가 textarea에 남아 다시 나간다.

영문 입력에서는 조합이 없어 재현되지 않는다. **한글에서만 난다.**

## 무엇을 하는가

조합 중인 Enter를 전송으로 보지 않게 한다.

**한 가지 방법에 기대지 마라.** `isComposing`은 브라우저·IME·OS 조합에 따라
동작이 갈린다. 일부 환경은 `keyCode 229`만 준다. 어떤 신호를 어떤 순서로
보는지 네가 정하되 **근거를 주석에 남겨라.**

`compositionstart`/`compositionend`를 직접 듣는 방법도 있다. 어느 쪽이든
**실제 한글 입력으로 검증한 것만 받아들인다.**

### 함께 볼 것

같은 형태가 다른 곳에 있는지 확인해라. 지금은 이 한 곳뿐인 것으로 보이지만,
**나중에 다시 들어온다.** 이 저장소는 규칙이 금지하지 않는 형태가 슬라이스마다
되돌아온 이력이 있다 (`CLAUDE.md`의 위치 접근 사례, 네 번 반복됐다).

Enter로 무언가를 확정하는 입력이 앞으로 늘어날 것을 전제하고,
**기계적으로 잡을 수 있는 방법이 있으면 제안해라.** 이번 슬라이스에서 만들지
말지는 네가 판단하되, 만들지 않기로 했다면 그 이유를 보고에 적어라.
(스크립트를 만든다면 `.claude/scripts/`에 두고, `AGENTS.md`·`CLAUDE.md`는 고치지 마라.)

## 건드리지 마라

`worker/`, `migrations/`, `wrangler.jsonc`.
발송 로직 자체(`submit`이 무엇을 보내는지)는 이 슬라이스가 아니다 —
**언제 부르는가**만 고친다.

**`AGENTS.md`·`CLAUDE.md`·계획서를 고치지 마라.** 고쳐야 할 것이 보이면
보고에 적어라.

## 수용 기준

부품이 아니라 **실제 입력**으로 확인해라.

1. `npm run check` 통과
2. **실제 브라우저에서 한글 `안녕하세요`를 치고 Enter를 누르면 메시지가 정확히
   한 건 전송된다.** 조합 글자가 입력창에 남지 않는다.
   유닛 테스트만으로 통과 판정하지 마라 — 이 결함은 유닛 테스트를 통과한 채
   운영에 나갔다
3. **영문 `hello` + Enter도 한 건**이다. 조합이 없는 입력이 막히면 안 된다
4. `Shift+Enter`는 여전히 줄바꿈이다
5. 조합 중 Enter 뒤에 **이어서 타자를 치면 정상 동작**한다 — 한 번 막고 나서
   입력이 죽으면 안 된다
6. 빈 입력에서 Enter는 아무 일도 하지 않는다
7. 회귀 테스트를 남긴다. **조합 중 Enter가 전송을 부르지 않는 것**을 잠가라
8. `python3 .claude/scripts/dead-exports.py` · `positional-consts.py` ·
   `unwired-routes.py` · `routes.py` 통과
9. 커밋하고 `origin/hoddukzoa12/g13-ime-enter`에 푸시한 뒤 해시를 보고해라.
   **배포하지 마라.**

## 막히면

범위가 애매하면 혼자 판단하지 말고 `ask`로 물어라. 답을 기다리며 멈추지 말고
막힌 지점만 남기고 나머지를 진행해라. 10분 내 답이 없으면 `escalation`을 올려라.
