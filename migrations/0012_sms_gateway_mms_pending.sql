-- MMS 헤더와 본문 이벤트의 ID가 달라 직접 결합할 수 없으므로, 다운로드를
-- 기다리는 헤더는 실제 실패와 분리한다. 진단 데이터라 office_id는 필요 없다.
CREATE TABLE sms_gateway_mms_pending (
  mo_key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  sender_e164 TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_sms_gateway_mms_pending_match
  ON sms_gateway_mms_pending(device_id, sender_e164, first_at);

-- downloaded 도착의 영구 정본은 messages다. 한 downloaded가 헤더 하나만
-- 해소했다는 영구 권리만 원장에 남겨 재생과 시간 만료가 다시 소비하지 못하게 한다.
CREATE TABLE sms_gateway_mms_matches (
  downloaded_mo_key TEXT PRIMARY KEY,
  received_mo_key TEXT NOT NULL UNIQUE,
  matched_at INTEGER NOT NULL
) STRICT;
