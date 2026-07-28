---

## API 슬라이스 공통 규약

묶음 5·6의 도메인 API 슬라이스가 공유하는 규약이다. 여기서 벗어나야 할 이유가
있으면 구현하지 말고 `ask`로 물어라.

### 인증 — 세 줄이면 붙는다

```ts
import { requireSession } from '../http/session'

const session = await requireSession(request, env)
if (session instanceof Response) return session
// 이후 session.userId / session.officeId / session.role 사용
```

**`officeId`와 `userId`는 반드시 세션에서 온다.** 요청 본문이나 쿼리에서 받지
마라. 클라이언트가 남의 사무소 id를 보내면 그대로 통과한다.

웹훅(`/api/hooks/*`)은 예외다 — 외부에서 오므로 세션이 없다.

### 권한은 SQL의 WHERE에서 강제한다

응용 코드의 `if`로만 막지 마라. **쿼리 자체가 남의 것을 못 건드리게** 짜라.

```sql
-- 메모 수정: 작성자만
UPDATE notes SET body = ?, updated_at = ? WHERE id = ? AND author_id = ?
-- 사무소 설정: 관리자만
UPDATE office_settings SET ... WHERE office_id = ?
  AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = '관리자')
```

**403 판정은 `meta.changes === 0`으로 한다.** 먼저 조회해서 확인한 뒤 수정하면
그 사이에 바뀔 수 있고, 조회 결과로 존재 여부가 새어나간다.

### 변경에는 이벤트를 함께 쓴다

서버 상태가 바뀌면 `events` 행이 남아야 실시간 동기화와 감사가 성립한다.

```ts
import { publish } from '../db/events'

const statements = [
  db.prepare('UPDATE ...').bind(...),
  ...publish(db, { officeId, type: '...', entity: '...', entityId, actorKind: 'user', actorId: userId, payload, createdAt: now }),
]
await executeBatch(db, statements)   // 같은 batch 안에서
```

**`publish()`는 batch를 실행하지 않는다.** 반환된 문장을 호출자 batch에 펼쳐
넣어야 원인 변경과 이벤트가 같은 트랜잭션이 된다. 따로 쓰면 "변경은 됐는데
이벤트가 없는" 상태가 생기고 클라이언트가 영원히 낡은 화면을 본다.

**변경이 실제로 일어났을 때만** 이벤트를 낸다. 멱등 재시도나 권한 실패로
0행이면 이벤트도 없어야 한다.

### 시각과 id

- 시각은 **epoch 밀리초 정수**. 포맷된 문자열을 저장하지 마라
- id는 `worker/lib/ids.ts`의 ULID. UUID를 새로 만들지 마라
- `Date.now()`를 함수 안에서 직접 부르지 말고 주입 가능하게 해라

### 오류

`worker/http/error.ts`의 코드를 쓴다. 새 코드가 필요하면 거기 추가하되,
**그 파일은 여러 슬라이스가 공유하므로 기존 항목을 건드리지 마라.**

오류 본문에 내부 정보를 흘리지 마라 — SQL 문, 스택, 존재 여부.

### 응답 모양

`shared/wire/`의 타입을 쓴다. 자기 슬라이스가 소유한 파일만 채워라.
**`shared/wire/index.ts` 배럴은 절대 수정하지 마라** — 이미 완성돼 있고
여러 슬라이스가 공유한다.

파생 가능한 값을 응답에 중복해 넣지 마라. 목록 미리보기는 마지막 메시지에서
조인해 만들고, 표시용 배지 문구는 클라이언트가 상태에서 파생한다.

### 하지 말 것

- `INSERT OR IGNORE` — NOT NULL·FK·CHECK 위반까지 삼킨다. 충돌 타깃을 명시한
  `ON CONFLICT`를 써라
- 모듈 전역에 요청 스코프 상태 저장
- 떠다니는 Promise — await하거나 반환하거나 `ctx.waitUntil()`에 넘겨라
- 응답 전체를 메모리에 올리는 것 (`await res.arrayBuffer()` 등)
- **테넌시 방어를 새로 쌓는 것.** 사무소 하나짜리 사내 도구다.
  세션에서 온 `officeId`로 스코프를 거는 것으로 충분하다

### 테스트

`@cloudflare/vitest-pool-workers`로 실제 workerd·D1에서 돌린다.
`SELF.fetch()`로 라우트를 호출해라. 테스트 이름은 **영문**이다.

권한·멱등성은 **실제로 위반을 시도해서** 막히는지 확인해라.
통과하는 테스트가 잘못된 것을 증명하고 있을 수 있다.
