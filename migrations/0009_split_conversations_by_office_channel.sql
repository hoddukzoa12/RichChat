-- conversations를 재생성하면 messages의 ON DELETE CASCADE가 실행되어 수신 이력이
-- 사라진다. 참조 컬럼은 NULL 허용으로 추가할 수 있으므로 테이블을 교체하지 않고,
-- 기존 행을 기본 업무폰으로 채운 뒤 가드로 완전성을 보장한다.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE conversations
  ADD COLUMN office_channel_id TEXT REFERENCES office_channels(id);

UPDATE conversations
SET office_channel_id = (
  SELECT office_channels.id
  FROM office_channels
  WHERE office_channels.office_id = conversations.office_id
    AND office_channels.is_default = 1
);

-- 기본 채널이 없어 미지정 행이 남으면 CHECK가 실패해 전체를 롤백한다.
CREATE TABLE migration_0009_data_guard (
  violations INTEGER NOT NULL CHECK (violations = 0)
) STRICT;

INSERT INTO migration_0009_data_guard (violations)
SELECT COUNT(*)
FROM conversations
WHERE office_channel_id IS NULL;

DROP TABLE migration_0009_data_guard;

DROP INDEX ux_conv_customer;

CREATE UNIQUE INDEX ux_conv_customer
  ON conversations(office_id, customer_id, office_channel_id);

-- 마이그레이션 전 복구 도구가 만든 미지정 행도 고객별 하나로 제한한다.
-- 운영 데이터와 애플리케이션 생성 경로는 항상 office_channel_id를 채운다.
CREATE UNIQUE INDEX ux_conv_customer_unassigned
  ON conversations(office_id, customer_id)
  WHERE office_channel_id IS NULL;

-- 기존에 끊어진 참조가 있거나 새 업무폰 FK가 유효하지 않으면 전체를 롤백한다.
CREATE TABLE migration_0009_fk_guard (
  violations INTEGER NOT NULL CHECK (violations = 0)
) STRICT;

INSERT INTO migration_0009_fk_guard (violations)
SELECT COUNT(*) FROM pragma_foreign_key_check;

DROP TABLE migration_0009_fk_guard;

PRAGMA defer_foreign_keys = OFF;
