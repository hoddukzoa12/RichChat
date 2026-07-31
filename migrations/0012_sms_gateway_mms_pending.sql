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

-- downloaded가 먼저 도착한 역순 호출에서 뒤늦은 헤더를 정상 처리로 흡수한다.
-- 성공 흔적은 대기 시간 뒤 조용히 지우며 mo_failures로 승격하지 않는다.
CREATE TABLE sms_gateway_mms_downloaded (
  mo_key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  sender_e164 TEXT NOT NULL,
  downloaded_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_sms_gateway_mms_downloaded_match
  ON sms_gateway_mms_downloaded(device_id, sender_e164, downloaded_at);
