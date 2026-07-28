-- 다운로드 리스는 겹친 Cron이 같은 LGU+ 파일을 중복 조회하지 않게 한다.
-- content_index는 웹훅 배열에서의 첨부 순서를 보존해 나중에 매핑 근거를 잃지 않게 한다.

ALTER TABLE message_attachments
  ADD COLUMN download_lease_until INTEGER NOT NULL DEFAULT 0
    CHECK (download_lease_until >= 0);

ALTER TABLE message_attachments
  ADD COLUMN content_index INTEGER NOT NULL DEFAULT 0
    CHECK (content_index >= 0);

CREATE INDEX ix_message_attachments_pending_download
  ON message_attachments(
    download_status,
    download_lease_until,
    created_at,
    id
  );
