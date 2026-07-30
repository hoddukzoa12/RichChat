-- 기존 메시지 시각은 정본으로 보수적으로 취급하고, 새 fallback만 애플리케이션이
-- 명시적으로 0을 저장한다. 테이블 재생성은 수신 이력을 CASCADE 삭제하므로 금지한다.
ALTER TABLE messages
  ADD COLUMN occurred_at_canonical INTEGER NOT NULL DEFAULT 1
    CHECK (occurred_at_canonical IN (0, 1));

-- MMS downloaded 한 세대의 본문과 첨부를 같은 조건부 쓰기로 묶는 내용 지문이다.
ALTER TABLE messages ADD COLUMN inbound_fingerprint TEXT;
