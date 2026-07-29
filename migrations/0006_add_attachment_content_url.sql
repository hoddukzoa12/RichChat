-- LGU+ MO 웹훅이 첨부마다 제공하는 공개 CloudFront URL을 서버 다운로드용으로만 보관한다.
-- 기존 대기 행은 원본 페이로드가 없어 NULL이며, 같은 mo_key 재수신 때 채워진다.

ALTER TABLE message_attachments
  ADD COLUMN content_url TEXT;
