-- 첨부의 office_id는 메시지와 함께 묶어 다른 사무소 메시지를 참조하지 못하게 한다.
-- R2 저장이 끝난 뒤에만 완료 상태와 객체 키를 함께 기록한다.

CREATE UNIQUE INDEX ux_messages_id_office
  ON messages(id, office_id);

CREATE TABLE message_attachments (
  id TEXT PRIMARY KEY,
  office_id TEXT NOT NULL REFERENCES offices(id),
  message_id TEXT NOT NULL,
  original_filename TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  mime_type TEXT,
  r2_key TEXT,
  download_status TEXT NOT NULL DEFAULT '대기'
    CHECK (download_status IN ('대기', '완료', '실패')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id, office_id)
    REFERENCES messages(id, office_id) ON DELETE CASCADE,
  CHECK (
    (
      download_status = '완료'
      AND original_filename IS NOT NULL
      AND byte_size IS NOT NULL
      AND mime_type IS NOT NULL
      AND r2_key IS NOT NULL
    )
    OR (
      download_status IN ('대기', '실패')
      AND r2_key IS NULL
    )
  )
) STRICT;

CREATE INDEX ix_message_attachments_message
  ON message_attachments(message_id, created_at, id);
