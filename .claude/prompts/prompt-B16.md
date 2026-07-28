## 역할

너는 RichChat 저장소의 슬라이스 B16을 구현한다. 다른 슬라이스는 건드리지 않는다.

**시작 전에 저장소 루트의 `AGENTS.md`를 읽고 그대로 따른다.**

## 목표

문자 발송의 **바이트 계산과 메시지 타입 선택**을 순수 함수로 만든다.
`shared/sms.ts` 하나와 그 테스트가 전부다.

프론트엔드의 글자수 카운터와 백엔드의 SMS/LMS 분기가 **같은 함수를 쓴다.**
두 곳이 다르게 세면 "화면엔 보내진다고 나오는데 실제로는 거부되는" 버그가 난다.

## 가장 중요한 것 — UTF-8이 아니다

```ts
new TextEncoder().encode(s).length   // ✗ 틀렸다. UTF-8이라 한글이 3바이트
```

LGU+는 **EUC-KR/CP949 기준**으로 센다. 한글이 **2바이트**다.
이걸 틀리면 90바이트 한도를 30자에서 걸리게 만들거나(너무 보수적),
2000바이트 LMS 한도를 넘겨 발송이 거부된다.

```ts
export const SMS_MAX_BYTES = 90
export const LMS_MAX_BYTES = 2000
export const LMS_TITLE_MAX_BYTES = 40

/** EUC-KR 기준 바이트 길이. ASCII 1, 그 외 2. UTF-8이 아니다. */
export function smsByteLength(text: string): number {
  let n = 0
  for (const ch of text) n += ch.codePointAt(0)! < 0x80 ? 1 : 2
  return n
}

export type MessageType = 'SMS' | 'LMS' | 'TOO_LONG'
export function pickMessageType(text: string): MessageType {
  const n = smsByteLength(text)
  return n <= SMS_MAX_BYTES ? 'SMS' : n <= LMS_MAX_BYTES ? 'LMS' : 'TOO_LONG'
}
```

**`for…of`로 코드포인트 단위 순회해야 한다.** `charCodeAt`이나 `split('')`을
쓰면 서로게이트 쌍(이모지 등)이 두 번 세진다.

## 이모지 처리

이모지는 CP949에 표현이 없어서 통신사에서 깨진다. 본문에 포함되어 있는지
판별하는 함수를 함께 제공해라 — 컴포저가 미리 막을 수 있도록.

이름과 시그니처는 네가 정하되, **판별만 하고 발송 여부를 결정하지는 마라.**
정책은 호출자 몫이다.

## 수용 기준

1. `npm run check` 통과
2. `smsByteLength('가') === 2`, `smsByteLength('a') === 1`, `smsByteLength('') === 0`
3. 한글 45자(90바이트) → `'SMS'`, 46자(92바이트) → `'LMS'` — **경계값을 정확히 테스트**
4. 한글 1000자(2000바이트) → `'LMS'`, 1001자(2002바이트) → `'TOO_LONG'`
5. 서로게이트 쌍이 2바이트로 계산되는 테스트 (예: `'😀'`가 4가 아니라 2)
6. `grep -c "TextEncoder" shared/sms.ts` → `0`
7. 순수 함수만 — `shared/sms.ts`에 React·D1·fetch import가 없다

## 건드리지 말 것

- `worker/`, `migrations/`, `src/` — 전부 다른 슬라이스 소유
- `shared/` 아래 `sms.ts`와 그 테스트를 제외한 모든 파일. 특히
  `shared/wire/index.ts` 배럴은 절대 수정하지 마라 — 여러 슬라이스가 공유한다
- `AGENTS.md`, `CLAUDE.md`, `wrangler.jsonc`, `design/`, `.claude/`, `.mcp.json`

## 완료 보고

수용 기준 7개 각각을 어떤 테스트·명령으로 확인했는지 실제 출력과 함께
`worker_done`으로 보고한다. 통과 못 한 게 있으면 숨기지 말고 그대로 적는다.

설계가 이상하다고 판단되면 구현하지 말고 `ask`로 물어라.
