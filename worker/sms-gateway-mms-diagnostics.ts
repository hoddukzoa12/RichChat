import { changes } from './db/d1'

// 운영 실측에서는 received와 downloaded가 1초 간격이었다. 일시적인 업무폰
// 다운로드 지연과 1분 크론 지터를 충분히 흡수하면서도 누락을 당일 발견하도록
// 관측값의 600배인 10분을 대기한다.
export const MMS_DOWNLOAD_WAIT_MS = 10 * 60 * 1_000

export const MMS_DOWNLOAD_MISSING_ERROR_TEXT =
  'MMS 헤더 수신 후 다운로드 이벤트가 오지 않았습니다.'

interface MmsHeaderIdentity {
  customerPhoneE164: string
  deviceId: string
}

interface PendingMmsHeaderInput extends MmsHeaderIdentity {
  idempotencyKey: string
  rawBody: string
  receivedAt: number
}

interface DownloadedMmsInput extends MmsHeaderIdentity {
  downloadedAt: number
  idempotencyKey: string
  rememberDownloaded: boolean
}

interface MmsHeaderPromotionSummary {
  promoted: number
}

/**
 * downloaded가 먼저 처리된 역순 호출이면 이미 저장된 MMS를 진단 범위에서만
 * 휴리스틱으로 결합한다. 고객 메시지 병합에는 이 추측을 절대 사용하지 않는다.
 */
export async function recordPendingMmsHeader(
  db: D1Database,
  input: PendingMmsHeaderInput,
): Promise<boolean> {
  const matched = await db
    .prepare(
      `DELETE FROM sms_gateway_mms_downloaded
       WHERE mo_key = (
         SELECT mo_key
         FROM sms_gateway_mms_downloaded
         WHERE device_id = ?
           AND sender_e164 = ?
           AND downloaded_at BETWEEN ? AND ?
         ORDER BY
           ABS(downloaded_at - ?),
           downloaded_at,
           mo_key
         LIMIT 1
       )`,
    )
    .bind(
      input.deviceId,
      input.customerPhoneE164,
      input.receivedAt - MMS_DOWNLOAD_WAIT_MS,
      input.receivedAt + MMS_DOWNLOAD_WAIT_MS,
      input.receivedAt,
    )
    .run()
  if (changes(matched) === 1) return false

  const result = await db
    .prepare(
      `INSERT INTO sms_gateway_mms_pending (
         mo_key, device_id, sender_e164, raw_json,
         attempts, first_at, last_at
       )
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(mo_key) DO UPDATE SET
         raw_json = excluded.raw_json,
         attempts = sms_gateway_mms_pending.attempts + 1,
         last_at = excluded.last_at`,
    )
    .bind(
      input.idempotencyKey,
      input.deviceId,
      input.customerPhoneE164,
      input.rawBody,
      input.receivedAt,
      input.receivedAt,
    )
    .run()

  return changes(result) === 1
}

/**
 * ID가 다른 두 이벤트를 고객 메시지에 추측으로 병합하지 않는다. 이 삭제는
 * 진단 대기열만 정리하므로 같은 기기·발신자의 가장 가까운 헤더를 휴리스틱으로
 * 골라도 잘못된 고객 본문이나 사진이 섞일 수 없다.
 */
export async function resolvePendingMmsHeader(
  db: D1Database,
  input: DownloadedMmsInput,
): Promise<boolean> {
  if (input.rememberDownloaded) {
    await db
      .prepare(
        `INSERT INTO sms_gateway_mms_downloaded (
           mo_key, device_id, sender_e164, downloaded_at
         )
         VALUES (?, ?, ?, ?)
         ON CONFLICT(mo_key) DO UPDATE SET
           downloaded_at = excluded.downloaded_at`,
      )
      .bind(
        input.idempotencyKey,
        input.deviceId,
        input.customerPhoneE164,
        input.downloadedAt,
      )
      .run()
  }

  const result = await db
    .prepare(
      `DELETE FROM sms_gateway_mms_pending
       WHERE mo_key = (
         SELECT mo_key
         FROM sms_gateway_mms_pending
         WHERE device_id = ?
           AND sender_e164 = ?
           AND first_at BETWEEN ? AND ?
         ORDER BY ABS(first_at - ?), first_at, mo_key
         LIMIT 1
       )`,
    )
    .bind(
      input.deviceId,
      input.customerPhoneE164,
      input.downloadedAt - MMS_DOWNLOAD_WAIT_MS,
      input.downloadedAt + MMS_DOWNLOAD_WAIT_MS,
      input.downloadedAt,
    )
    .run()

  const resolved = changes(result) === 1
  if (resolved && input.rememberDownloaded) {
    await db
      .prepare(
        `DELETE FROM sms_gateway_mms_downloaded
         WHERE mo_key = ?`,
      )
      .bind(input.idempotencyKey)
      .run()
  }
  return resolved
}

export async function promoteStaleMmsHeaders(
  db: D1Database,
  now: number = Date.now(),
): Promise<MmsHeaderPromotionSummary> {
  const cutoff = now - MMS_DOWNLOAD_WAIT_MS
  const [promotion] = await db.batch([
    db
      .prepare(
        `INSERT INTO mo_failures (
           mo_key, raw_json, error_text, attempts, first_at, last_at
         )
         SELECT mo_key, raw_json, ?, attempts, first_at, ?
         FROM sms_gateway_mms_pending
         WHERE first_at <= ?
         ON CONFLICT(mo_key) DO UPDATE SET
           raw_json = excluded.raw_json,
           error_text = excluded.error_text,
           attempts = MAX(mo_failures.attempts, excluded.attempts),
           first_at = MIN(mo_failures.first_at, excluded.first_at),
           last_at = excluded.last_at`,
      )
      .bind(MMS_DOWNLOAD_MISSING_ERROR_TEXT, now, cutoff),
    db
      .prepare(
        `DELETE FROM sms_gateway_mms_pending
         WHERE first_at <= ?`,
      )
      .bind(cutoff),
    db
      .prepare(
        `DELETE FROM sms_gateway_mms_downloaded
         WHERE downloaded_at <= ?`,
      )
      .bind(cutoff),
  ])

  return { promoted: changes(promotion) }
}
