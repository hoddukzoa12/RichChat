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

interface PendingMmsRow {
  device_id: string
  first_at: number
  mo_key: string
  sender_e164: string
}

interface DownloadedMmsRow {
  device_id: string
  downloaded_at: number
  mo_key: string
  sender_e164: string
}

interface MmsMatch {
  downloadedMoKey: string
  receivedMoKey: string
}

interface MmsHeaderPromotionSummary {
  matched: number
  promoted: number
}

const DOWNLOADED_MESSAGE_FROM = `
  FROM messages AS downloaded
  INNER JOIN conversations
    ON conversations.id = downloaded.conversation_id
  INNER JOIN customers
    ON customers.id = conversations.customer_id
  INNER JOIN office_channels
    ON office_channels.id = conversations.office_channel_id
  LEFT JOIN sms_gateway_mms_matches
    ON sms_gateway_mms_matches.downloaded_mo_key = downloaded.mo_key`

const DOWNLOADED_MESSAGE_FILTER = `
  downloaded.direction = 'in'
  AND downloaded.channel = 'MMS'
  AND downloaded.mo_key GLOB 'sms-gateway/*'
  AND office_channels.device_id IS NOT NULL
  AND sms_gateway_mms_matches.downloaded_mo_key IS NULL`

/**
 * 웹훅은 수신 사실만 append하고 해소를 판정하지 않는다. 미매칭 received 재생은
 * pending 시도 횟수만 늘리고, 영구 원장에 있는 재생은 새 행을 만들지 않는다.
 */
export async function recordPendingMmsHeader(
  db: D1Database,
  input: PendingMmsHeaderInput,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO sms_gateway_mms_pending (
         mo_key, device_id, sender_e164, raw_json,
         attempts, first_at, last_at
       )
       SELECT ?, ?, ?, ?, 1, ?, ?
       WHERE NOT EXISTS (
         SELECT 1
         FROM sms_gateway_mms_matches
         WHERE received_mo_key = ?
       )
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
      input.idempotencyKey,
    )
    .run()

  return changes(result) === 1
}

function matchKey(deviceId: string, senderE164: string): string {
  return `${deviceId}\u0000${senderE164}`
}

/**
 * 기기·발신자별 양쪽 시각순으로 가장 이른 유효 downloaded를 하나만 소비한다.
 * 이 추측은 진단 pending만 정리하며 고객 메시지 본문이나 첨부를 병합하지 않는다.
 */
function greedyMmsMatches(
  pending: readonly PendingMmsRow[],
  downloaded: readonly DownloadedMmsRow[],
): MmsMatch[] {
  const downloadsBySender = new Map<string, DownloadedMmsRow[]>()
  for (const item of downloaded) {
    const key = matchKey(item.device_id, item.sender_e164)
    const group = downloadsBySender.get(key)
    if (group === undefined) {
      downloadsBySender.set(key, [item])
    } else {
      group.push(item)
    }
  }

  const nextDownloadIndex = new Map<string, number>()
  const matches: MmsMatch[] = []
  for (const header of pending) {
    const key = matchKey(header.device_id, header.sender_e164)
    const downloads = downloadsBySender.get(key)
    if (downloads === undefined) continue

    let index = nextDownloadIndex.get(key) ?? 0
    const earliest = header.first_at - MMS_DOWNLOAD_WAIT_MS
    while (
      downloads[index] !== undefined &&
      downloads[index].downloaded_at < earliest
    ) {
      index += 1
    }

    const candidate = downloads[index]
    if (
      candidate === undefined ||
      candidate.downloaded_at >
        header.first_at + MMS_DOWNLOAD_WAIT_MS
    ) {
      nextDownloadIndex.set(key, index)
      continue
    }

    matches.push({
      downloadedMoKey: candidate.mo_key,
      receivedMoKey: header.mo_key,
    })
    nextDownloadIndex.set(key, index + 1)
  }

  return matches
}

async function pendingMmsHeaders(
  db: D1Database,
): Promise<PendingMmsRow[]> {
  const result = await db
    .prepare(
      `SELECT mo_key, device_id, sender_e164, first_at
       FROM sms_gateway_mms_pending
       ORDER BY device_id, sender_e164, first_at, mo_key`,
    )
    .all<PendingMmsRow>()
  return result.results
}

async function unmatchedDownloadedMms(
  db: D1Database,
  earliestPendingAt: number,
  latestPendingAt: number,
): Promise<DownloadedMmsRow[]> {
  const result = await db
    .prepare(
      `SELECT
         downloaded.mo_key,
         office_channels.device_id,
         customers.phone_e164 AS sender_e164,
         downloaded.created_at AS downloaded_at
       ${DOWNLOADED_MESSAGE_FROM}
       WHERE ${DOWNLOADED_MESSAGE_FILTER}
         AND downloaded.created_at BETWEEN ? AND ?
       ORDER BY
         office_channels.device_id,
         customers.phone_e164,
         downloaded.created_at,
         downloaded.mo_key`,
    )
    .bind(
      earliestPendingAt - MMS_DOWNLOAD_WAIT_MS,
      latestPendingAt + MMS_DOWNLOAD_WAIT_MS,
    )
    .all<DownloadedMmsRow>()
  return result.results
}

export async function promoteStaleMmsHeaders(
  db: D1Database,
  now: number = Date.now(),
): Promise<MmsHeaderPromotionSummary> {
  const pending = await pendingMmsHeaders(db)
  let earliestPendingAt = Number.POSITIVE_INFINITY
  let latestPendingAt = Number.NEGATIVE_INFINITY
  for (const header of pending) {
    earliestPendingAt = Math.min(earliestPendingAt, header.first_at)
    latestPendingAt = Math.max(latestPendingAt, header.first_at)
  }
  const downloaded =
    pending.length === 0
      ? []
      : await unmatchedDownloadedMms(
          db,
          earliestPendingAt,
          latestPendingAt,
        )
  const matches = greedyMmsMatches(pending, downloaded)
  const statements: D1PreparedStatement[] = []
  const matchInsertIndexes: number[] = []

  for (const match of matches) {
    matchInsertIndexes.push(statements.length)
    statements.push(
      db
        .prepare(
          `INSERT INTO sms_gateway_mms_matches (
           downloaded_mo_key, received_mo_key, matched_at
           ) VALUES (?, ?, ?)
           ON CONFLICT(downloaded_mo_key) DO NOTHING
           ON CONFLICT(received_mo_key) DO NOTHING`,
        )
        .bind(
          match.downloadedMoKey,
          match.receivedMoKey,
          now,
        ),
      db
        .prepare(
          `DELETE FROM sms_gateway_mms_pending
           WHERE mo_key = ?
             AND EXISTS (
               SELECT 1
               FROM sms_gateway_mms_matches
               WHERE downloaded_mo_key = ?
                 AND received_mo_key = ?
             )`,
        )
        .bind(
          match.receivedMoKey,
          match.downloadedMoKey,
          match.receivedMoKey,
        ),
    )
  }

  const cutoff = now - MMS_DOWNLOAD_WAIT_MS
  const promotionIndex = statements.length
  statements.push(
    db
      .prepare(
        `INSERT INTO mo_failures (
           mo_key, raw_json, error_text, attempts, first_at, last_at
         )
         SELECT
           pending.mo_key,
           pending.raw_json,
           ?,
           pending.attempts,
           pending.first_at,
           ?
         FROM sms_gateway_mms_pending AS pending
         WHERE pending.first_at <= ?
           AND NOT EXISTS (
             SELECT 1
             ${DOWNLOADED_MESSAGE_FROM}
             WHERE ${DOWNLOADED_MESSAGE_FILTER}
               AND office_channels.device_id = pending.device_id
               AND customers.phone_e164 = pending.sender_e164
               AND downloaded.created_at
                 BETWEEN pending.first_at - ? AND pending.first_at + ?
           )
         ON CONFLICT(mo_key) DO UPDATE SET
           raw_json = excluded.raw_json,
           error_text = excluded.error_text,
           attempts = MAX(mo_failures.attempts, excluded.attempts),
           first_at = MIN(mo_failures.first_at, excluded.first_at),
           last_at = excluded.last_at`,
      )
      .bind(
        MMS_DOWNLOAD_MISSING_ERROR_TEXT,
        now,
        cutoff,
        MMS_DOWNLOAD_WAIT_MS,
        MMS_DOWNLOAD_WAIT_MS,
      ),
    db
      .prepare(
        `DELETE FROM sms_gateway_mms_pending
         WHERE first_at <= ?
           AND EXISTS (
             SELECT 1
             FROM mo_failures
             WHERE mo_failures.mo_key =
               sms_gateway_mms_pending.mo_key
               AND mo_failures.error_text = ?
           )`,
      )
      .bind(cutoff, MMS_DOWNLOAD_MISSING_ERROR_TEXT),
  )

  const results = await db.batch(statements)
  return {
    matched: matchInsertIndexes.reduce(
      (total, index) => total + changes(results[index]!),
      0,
    ),
    promoted: changes(results[promotionIndex]!),
  }
}
