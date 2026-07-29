-- D1은 마이그레이션을 트랜잭션 안에서 실행해 foreign_keys를 끌 수 없다.
-- 대신 부모 테이블 교체 중의 위반만 커밋 직전까지 미루고, 같은 트랜잭션에서
-- users 이름과 모든 행을 복구한 뒤 검증을 다시 켠다.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE users_with_deputy_administrator (
  id TEXT PRIMARY KEY,
  office_id TEXT NOT NULL REFERENCES offices(id),
  email TEXT NOT NULL,
  works_sub TEXT,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('관리자', '부관리자', '세무사', '상담 담당')),
  status TEXT NOT NULL DEFAULT '초대'
    CHECK (status IN ('초대', '활성', '비활성')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO users_with_deputy_administrator (
  id,
  office_id,
  email,
  works_sub,
  name,
  title,
  role,
  status,
  created_at,
  updated_at
)
SELECT
  id,
  office_id,
  email,
  works_sub,
  name,
  title,
  role,
  status,
  created_at,
  updated_at
FROM users;

DROP TABLE users;

ALTER TABLE users_with_deputy_administrator RENAME TO users;

CREATE UNIQUE INDEX ux_users_email ON users(email);
CREATE UNIQUE INDEX ux_users_works_sub
  ON users(works_sub)
  WHERE works_sub IS NOT NULL;
CREATE UNIQUE INDEX ux_users_id_office
  ON users(id, office_id);

PRAGMA defer_foreign_keys = OFF;
