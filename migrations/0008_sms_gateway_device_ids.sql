-- 업무폰의 Android SMS Gateway 기기 ID로 수신 채널과 사무소를 찾는다.
-- 기존 LGU+ 채널에는 값이 없으므로 NULL을 허용하고, 한 기기는 한 채널에만 둔다.
ALTER TABLE office_channels ADD COLUMN device_id TEXT;

CREATE UNIQUE INDEX ux_office_channels_device_id
  ON office_channels(device_id);
