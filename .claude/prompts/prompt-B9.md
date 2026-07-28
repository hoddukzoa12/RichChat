<!-- api-conventions -->

## 목표

대화의 **상태·보관·라벨**과 **담당자 배정**.

```
PATCH  /api/conversations/:id                     { status?, archived?, label?, version }
POST   /api/conversations/:id/assignees/:userId
DELETE /api/conversations/:id/assignees/:userId
```

## 반드시 지킬 것

### 담당자 배정 — 토글로 만들지 마라

프로토타입은 이걸 토글로 구현했다. 낡은 배열을 읽어 다음 상태를 계산하므로
**두 사람이 동시에 배정하면 한쪽이 사라진다.**

`POST`는 배정, `DELETE`는 해제로 **방향을 명시**해라. 같은 요청을 두 번 보내도
결과가 같아야 한다.

`conversation_assignees`는 `(conversation_id, user_id)` 복합 PK다. 배정은
충돌 타깃을 명시한 `ON CONFLICT DO NOTHING`, 해제는 `DELETE`다.

**이벤트는 실제로 바뀌었을 때만** 낸다. 이미 배정된 사람을 또 배정하면
`meta.changes === 0`이므로 이벤트도 없어야 한다. 안 그러면 클릭 연타가
감사 로그를 오염시킨다.

### 낙관적 잠금

`PATCH`는 `version`을 받는다.

```sql
UPDATE conversations SET status = ?, version = version + 1, updated_at = ?
 WHERE id = ? AND version = ?
```

`meta.changes === 0`이면 **409**다. 응답에 현재 서버 값을 실어 클라이언트가
갱신할 수 있게 해라.

**409일 때 데이터가 하나도 안 바뀌어야 한다.** 부분 적용은 없다.

### 상태는 트리아지 표시다

`미처리`·`처리중`·`완료`는 "지금 뭘 봐야 하나"를 위한 것이다. 세무 업무 추적은
`tasks`가 따로 한다 (B12). **여기서 업무를 건드리지 마라.**

값은 DB에도 한글 그대로다. `CHECK (status IN ('미처리','처리중','완료'))`가
TS 유니온과 문자 그대로 일치한다. 영문 enum으로 매핑하지 마라.

### 보관은 상태와 다른 축이다

`archived_at`이 `NULL`이면 보관 아님이다. **`status`에 `보관`을 넣지 마라** —
보관된 `처리중` 대화가 표현 불가능해진다.

보관·해제로 `status`를 바꾸지 마라. 두 축은 독립이다.

### 자동 배정은 여기가 아니다

"첫 응신 시 미배정이면 발신자 자동 배정"은 **발송 경로(B17)** 소유다. 여기서
같은 규칙을 구현하면 두 곳에 살게 된다.

### 존재하지 않는 사용자

없는 `userId`로 배정하려 하면 FK가 막는다. 그 실패를 500으로 흘리지 말고
**400 또는 404로 번역**해라.

## 수용 기준

1. `npm run check` 통과
2. 쿠키 없이 호출 → 401
3. **같은 사용자를 두 번 배정 → 행 1개, 이벤트 1건**
4. **배정 후 해제 → 원상복구.** 배정/해제를 번갈아 여러 번 해도 상태가 정확
5. 두 사용자를 각각 배정 → 둘 다 남는다 (한쪽이 다른 쪽을 지우지 않는다)
6. stale `version`으로 PATCH → **409, 그리고 행이 전혀 안 바뀜**
7. 성공 PATCH 후 `version`이 증가한다
8. 보관해도 `status`가 유지된다. 보관된 `처리중`이 표현 가능하다
9. 변경 1건당 `events` 1건. **0행 변경 시 이벤트 0건**
10. 없는 `userId` 배정 → 400/404 (500 아님)
11. 없는 대화 id → 404

## 만들지 말 것

- 목록·상세 조회 — B6·B7 소유
- 발송, 자동 배정 — B17 소유
- 업무·메모 — B12·B11 소유
- 프론트엔드(`src/`), `migrations/`, `wrangler.jsonc` 수정
