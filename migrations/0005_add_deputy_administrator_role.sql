-- D1은 마이그레이션을 트랜잭션 안에서 실행해 foreign_keys를 끌 수 없다.
-- 부모 테이블 교체 중의 위반은 미루고, 교체 뒤 실제 데이터를 FK 가드로 검사한다.
-- 마지막 defer_foreign_keys=OFF는 위반을 검사하지 않고 DROP이 남긴 낡은
-- 지연 카운터만 비워 커밋을 가능하게 한다.
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

-- 실제 FK 위반이 하나라도 있으면 CHECK가 실패해 마이그레이션 전체를 롤백한다.
CREATE TABLE migration_0005_fk_guard (
  violations INTEGER NOT NULL CHECK (violations = 0)
) STRICT;

INSERT INTO migration_0005_fk_guard (violations)
SELECT COUNT(*) FROM pragma_foreign_key_check;

DROP TABLE migration_0005_fk_guard;

PRAGMA defer_foreign_keys = OFF;
