-- 업무폰 앱과 수신 웹훅이 공유하는 서명키를 채널 행에 둔다.
-- 아직 발급하지 않은 업무폰과 LGU+ 대표번호는 NULL을 유지한다.
ALTER TABLE office_channels ADD COLUMN signing_key TEXT;
