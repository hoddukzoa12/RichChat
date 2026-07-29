-- 발송 전 브라우저가 올린 이미지는 메시지 생성 전까지 별도 대기열에 둔다.
-- conversation_id는 실제 조회 범위에 필요하지만, 단일 사무소 도구이므로 office_id는 중복 저장하지 않는다.

CREATE TABLE outbound_attachment_uploads (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/gif')),
  r2_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_outbound_attachment_uploads_conversation
  ON outbound_attachment_uploads(conversation_id, created_at, id);
