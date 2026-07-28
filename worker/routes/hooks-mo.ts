import type { SendChannel } from '../../shared/domain'
import { changes } from '../db/d1'
import { publish } from '../db/events'
import { error } from '../http/error'
import { json } from '../http/respond'
import type { Route, RouteHandler } from '../http/router'
import { createId, type Clock } from '../lib/ids'
import { executeBatchAndBroadcast } from '../realtime/broadcast'

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000
const QUARANTINE_ATTEMPTS = 3
export const INVALID_ITEM_KEY_PREFIX = 'invalid-item-sha256:'
const INVALID_ENVELOPE_KEY_PREFIX = 'invalid-envelope-sha256:'
const SUCCESS_BODY = { code: '10000', message: 'success' } as const
const RETRY_BODY = { code: '99999', message: 'retry' } as const

type MoType = 'SMSMO' | 'MMSMO' | 'RCSMO'

interface MoContent {
  contentName: string
  contentSize: number
  contentExt: string
  contentUrl: string
}

interface MoItem {
  moKey: string
  moNumber: string
  moType: MoType
  moCallback: string
  moMsg: string
  moRecvDt: string
  telco: string
  contentCnt: number
  contentInfoLst: MoContent[]
}

interface MoEnvelope {
  moCnt: number
  moLst: unknown[]
}

interface PreparedMo {
  item: MoItem
  occurredAt: number
  inputIndex: number
  phoneE164: string
  channel: SendChannel
}

interface DeterministicFailure {
  key: string
  raw: unknown
  cause: PayloadValidationError
}

interface OfficeRow {
  id: string
}

interface FailureRow {
  attempts: number
}

class PayloadValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PayloadValidationError'
  }
}

const MO_CHANNEL: Record<MoType, SendChannel> = {
  SMSMO: 'SMS',
  MMSMO: 'MMS',
  // RCS 계약 없음. 고객 문의 유실보다 부정확한 채널 라벨을 택한다.
  RCSMO: 'MMS',
}

const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMoType(value: unknown): value is MoType {
  return typeof value === 'string' && Object.hasOwn(MO_CHANNEL, value)
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new PayloadValidationError(`${key} 값이 올바르지 않습니다.`)
  }
  return value
}

function stringValue(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key]
  if (typeof value !== 'string') {
    throw new PayloadValidationError(`${key} 값이 올바르지 않습니다.`)
  }
  return value
}

function nonNegativeInteger(value: unknown, key: string): number {
  const parsed =
    typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : value

  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new PayloadValidationError(`${key} 값이 올바르지 않습니다.`)
  }
  return parsed
}

function parseContent(value: unknown): MoContent {
  if (!isRecord(value)) {
    throw new PayloadValidationError(
      'contentInfoLst 항목이 올바르지 않습니다.',
    )
  }

  return {
    contentName: requiredString(value, 'contentName'),
    contentSize: nonNegativeInteger(value.contentSize, 'contentSize'),
    contentExt: requiredString(value, 'contentExt'),
    contentUrl: requiredString(value, 'contentUrl'),
  }
}

function parseItem(value: unknown): MoItem {
  if (!isRecord(value)) {
    throw new PayloadValidationError('moLst 항목이 올바르지 않습니다.')
  }

  const moType = value.moType
  if (!isMoType(moType)) {
    throw new PayloadValidationError('moType 값이 올바르지 않습니다.')
  }

  if (!Array.isArray(value.contentInfoLst)) {
    throw new PayloadValidationError('contentInfoLst 값이 올바르지 않습니다.')
  }

  const contentCnt = nonNegativeInteger(value.contentCnt, 'contentCnt')
  const contentInfoLst = value.contentInfoLst.map(parseContent)
  if (contentCnt !== contentInfoLst.length) {
    throw new PayloadValidationError(
      'contentCnt와 contentInfoLst 길이가 다릅니다.',
    )
  }

  return {
    moKey: requiredString(value, 'moKey'),
    moNumber: requiredString(value, 'moNumber'),
    moType,
    moCallback: requiredString(value, 'moCallback'),
    moMsg: stringValue(value, 'moMsg'),
    moRecvDt: requiredString(value, 'moRecvDt'),
    telco: requiredString(value, 'telco'),
    contentCnt,
    contentInfoLst,
  }
}

function parseEnvelope(value: unknown): MoEnvelope {
  if (!isRecord(value) || !Array.isArray(value.moLst)) {
    throw new PayloadValidationError('MO 페이로드가 올바르지 않습니다.')
  }

  const moCnt = nonNegativeInteger(value.moCnt, 'moCnt')
  if (moCnt !== value.moLst.length) {
    throw new PayloadValidationError('moCnt와 moLst 길이가 다릅니다.')
  }

  return { moCnt, moLst: value.moLst }
}

/**
 * LGU+의 KST yyyyMMddHHmmss를 epoch 밀리초로 바꾼다.
 * 범위를 벗어난 날짜는 Date의 자동 보정을 허용하지 않고 거부한다.
 */
export function parseMoRecvDt(value: string): number | null {
  const match =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value)
  if (!match) return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const epoch =
    Date.UTC(year, month - 1, day, hour, minute, second) - KST_OFFSET_MS
  const reconstructed = new Date(epoch + KST_OFFSET_MS)

  if (
    reconstructed.getUTCFullYear() !== year ||
    reconstructed.getUTCMonth() !== month - 1 ||
    reconstructed.getUTCDate() !== day ||
    reconstructed.getUTCHours() !== hour ||
    reconstructed.getUTCMinutes() !== minute ||
    reconstructed.getUTCSeconds() !== second
  ) {
    return null
  }

  return epoch
}

export function normalizeKoreanPhone(value: string): string {
  const digits = value.replace(/[^\d]/g, '')
  if (/^0\d{8,10}$/.test(digits)) {
    return `+82${digits.slice(1)}`
  }
  if (/^82\d{8,10}$/.test(digits)) {
    return `+${digits}`
  }
  throw new PayloadValidationError(
    '국내 전화번호 형식이 올바르지 않습니다.',
  )
}

async function digest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
      )
    return `{${entries.join(',')}}`
  }

  const scalar = JSON.stringify(value)
  if (scalar === undefined) {
    throw new Error('JSON 값의 안정 해시를 만들 수 없습니다.')
  }
  return scalar
}

function hex(bytes: Uint8Array): string {
  let encoded = ''
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, '0')
  return encoded
}

async function syntheticFailureKey(
  raw: unknown,
  prefix: string,
): Promise<string> {
  return `${prefix}${hex(await digest(stableJson(raw)))}`
}

async function itemFailureKey(raw: unknown): Promise<string> {
  if (
    isRecord(raw) &&
    typeof raw.moKey === 'string' &&
    raw.moKey !== ''
  ) {
    return raw.moKey
  }
  return syntheticFailureKey(raw, INVALID_ITEM_KEY_PREFIX)
}

async function constantTimeEqual(
  candidate: string,
  expected: string,
): Promise<boolean> {
  const [candidateDigest, expectedDigest] = await Promise.all([
    digest(candidate),
    digest(expected),
  ])
  let difference = 0

  for (let index = 0; index < candidateDigest.length; index += 1) {
    difference |= candidateDigest[index] ^ expectedDigest[index]
  }

  return difference === 0
}

function retryResponse(status = 500): Response {
  return json(RETRY_BODY, { status })
}

function successResponse(): Response {
  return json(SUCCESS_BODY)
}

function originalFilename(content: MoContent): string {
  const extension = content.contentExt.replace(/^\./, '')
  const suffix = `.${extension}`.toLocaleLowerCase('en-US')
  return content.contentName.toLocaleLowerCase('en-US').endsWith(suffix)
    ? content.contentName
    : `${content.contentName}.${extension}`
}

function mimeType(content: MoContent): string {
  const extension = content.contentExt.replace(/^\./, '').toLowerCase()
  return MIME_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

function prepareItem(raw: unknown, inputIndex: number): PreparedMo {
  const item = parseItem(raw)
  // 파싱된 시각은 지연 정도와 무관하게 정본이다. 서버 시각으로 대체하지 않는다.
  const occurredAt = parseMoRecvDt(item.moRecvDt)
  if (occurredAt === null) {
    throw new PayloadValidationError(
      'moRecvDt가 유효한 KST 날짜가 아닙니다.',
    )
  }

  return {
    item,
    occurredAt,
    inputIndex,
    phoneE164: normalizeKoreanPhone(item.moCallback),
    channel: MO_CHANNEL[item.moType],
  }
}

async function findOffice(db: D1Database): Promise<OfficeRow> {
  const office = await db
    .prepare('SELECT id FROM offices ORDER BY created_at, id LIMIT 1')
    .first<OfficeRow>()

  if (!office) {
    throw new Error('MO를 귀속할 사무소가 없습니다.')
  }
  return office
}

async function isQuarantined(
  db: D1Database,
  moKey: string,
): Promise<boolean> {
  const failure = await db
    .prepare('SELECT attempts FROM mo_failures WHERE mo_key = ?')
    .bind(moKey)
    .first<FailureRow>()
  return (failure?.attempts ?? 0) >= QUARANTINE_ATTEMPTS
}

function failureText(cause: unknown): string {
  if (!(cause instanceof Error)) return '알 수 없는 MO 처리 오류'
  return `${cause.name}: ${cause.message}`.slice(0, 1_000)
}

async function recordFailure(
  db: D1Database,
  moKey: string,
  raw: unknown,
  cause: PayloadValidationError,
  now: number,
): Promise<number> {
  const failure = await db
    .prepare(
      `INSERT INTO mo_failures (
         mo_key, raw_json, error_text, attempts, first_at, last_at
       )
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(mo_key) DO UPDATE SET
         raw_json = excluded.raw_json,
         error_text = excluded.error_text,
         attempts = mo_failures.attempts + 1,
         last_at = excluded.last_at
       RETURNING attempts`,
    )
    .bind(
      moKey,
      JSON.stringify(raw),
      failureText(cause),
      now,
      now,
    )
    .first<FailureRow>()

  if (!failure) {
    throw new Error('MO 실패 횟수를 기록하지 못했습니다.')
  }
  return failure.attempts
}

async function quarantineDeterministicFailure(
  db: D1Database,
  failure: DeterministicFailure,
  now: number,
): Promise<boolean> {
  if (await isQuarantined(db, failure.key)) return true

  const attempts = await recordFailure(
    db,
    failure.key,
    failure.raw,
    failure.cause,
    now,
  )
  return attempts >= QUARANTINE_ATTEMPTS
}

async function processItem(
  env: Env,
  prepared: PreparedMo,
  receivedAt: number,
  ctx?: ExecutionContext,
): Promise<void> {
  const { item, occurredAt, channel, phoneE164 } = prepared
  const db = env.DB
  const office = await findOffice(db)
  const customerId = createId()
  const conversationId = createId()
  const messageId = createId()

  console.info('LGU+ MO 수신 채널을 저장 채널로 매핑합니다.', {
    moKey: item.moKey,
    moType: item.moType,
    storedChannel: channel,
  })

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO customers (
           id, office_id, phone_e164, name, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM messages WHERE mo_key = ?
         )
         ON CONFLICT(office_id, phone_e164) DO NOTHING`,
      )
      .bind(
        customerId,
        office.id,
        phoneE164,
        phoneE164,
        receivedAt,
        receivedAt,
        item.moKey,
      ),
    db
      .prepare(
        `INSERT INTO conversations (
           id, office_id, customer_id, status, last_message_id,
           last_message_at, created_at, updated_at
         )
         SELECT ?, ?, id, '미처리', NULL, NULL, ?, ?
         FROM customers
         WHERE office_id = ?
           AND phone_e164 = ?
           AND NOT EXISTS (
             SELECT 1 FROM messages WHERE mo_key = ?
           )
         ON CONFLICT(office_id, customer_id) DO NOTHING`,
      )
      .bind(
        conversationId,
        office.id,
        receivedAt,
        receivedAt,
        office.id,
        phoneE164,
        item.moKey,
      ),
    db
      .prepare(
        `INSERT INTO messages (
           id, office_id, conversation_id, direction, channel, title, body,
           sender_user_id, occurred_at, created_at, mo_key, client_key,
           msg_key, delivery_status
         )
         SELECT
           ?, ?, id, 'in', ?, NULL, ?, NULL, ?, ?, ?, NULL, NULL, '수신'
         FROM conversations
         WHERE office_id = ?
           AND customer_id = (
             SELECT id FROM customers
             WHERE office_id = ? AND phone_e164 = ?
           )
         ON CONFLICT(mo_key) WHERE mo_key IS NOT NULL DO NOTHING`,
      )
      .bind(
        messageId,
        office.id,
        channel,
        item.moMsg,
        occurredAt,
        receivedAt,
        item.moKey,
        office.id,
        office.id,
        phoneE164,
      ),
  ]
  const messageInsertIndex = statements.length - 1

  // 일회성 contentUrl은 보관하지 않는다. 대기 행은 7일 보관 API로 복구한다.
  for (const [contentIndex, content] of item.contentInfoLst.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO message_attachments (
             id, office_id, message_id, original_filename, byte_size,
             mime_type, r2_key, download_status, created_at, content_index
           )
           SELECT ?, ?, id, ?, ?, ?, NULL, '대기', ?, ?
           FROM messages
           WHERE id = ? AND mo_key = ?`,
        )
        .bind(
          createId(),
          office.id,
          originalFilename(content),
          content.contentSize,
          mimeType(content),
          receivedAt,
          contentIndex,
          messageId,
          item.moKey,
        ),
    )
  }

  const publication = publish(
    db,
    {
      officeId: office.id,
      type: 'message.created',
      entity: 'message',
      entityId: messageId,
      actorKind: 'customer',
      payload: {
        direction: 'in',
        channel,
        moType: item.moType,
        moNumber: item.moNumber,
      },
      createdAt: receivedAt,
    },
    {
      query: 'SELECT 1 FROM messages WHERE id = ? AND mo_key = ?',
      bindings: [messageId, item.moKey],
    },
  )
  statements.push(
    db
      .prepare(
        `WITH incoming AS (
           SELECT id, conversation_id, occurred_at
           FROM messages
           WHERE id = ? AND mo_key = ?
         ),
         projection AS (
           SELECT
             incoming.id,
             incoming.conversation_id,
             incoming.occurred_at,
             CASE
               WHEN conversations.last_message_at IS NULL
                 OR incoming.occurred_at > conversations.last_message_at
                 OR (
                   incoming.occurred_at = conversations.last_message_at
                   AND incoming.id > conversations.last_message_id
                 )
               THEN 1
               ELSE 0
             END AS is_latest
           FROM incoming
           JOIN conversations
             ON conversations.id = incoming.conversation_id
         )
         UPDATE conversations
         SET
           last_message_id = CASE
             WHEN (SELECT is_latest FROM projection) = 1
             THEN (SELECT id FROM projection)
             ELSE last_message_id
           END,
           last_message_at = CASE
             WHEN (SELECT is_latest FROM projection) = 1
             THEN (SELECT occurred_at FROM projection)
             ELSE last_message_at
           END,
           inbound_count = inbound_count + 1,
           status = CASE WHEN status = '완료' THEN '미처리' ELSE status END,
           version = version + 1,
           updated_at = ?
         WHERE id = (SELECT conversation_id FROM projection)`,
      )
      .bind(messageId, item.moKey, receivedAt),
    ...publication,
    db
      .prepare('DELETE FROM mo_failures WHERE mo_key = ?')
      .bind(item.moKey),
  )

  const results = await executeBatchAndBroadcast(
    db,
    statements,
    [publication],
    ctx,
    env,
  )
  if (changes(results[messageInsertIndex]) === 1) return

  const duplicate = await db
    .prepare('SELECT id FROM messages WHERE mo_key = ?')
    .bind(item.moKey)
    .first<{ id: string }>()
  if (!duplicate) {
    throw new Error('MO 메시지가 커밋되지 않았습니다.')
  }
}

export function createMoWebhookHandler(clock: Clock = Date.now): RouteHandler {
  return async (request, env, params, ctx) => {
    const expectedSecret = env.LGU_MO_WEBHOOK_SECRET
    const candidateSecret = params.secret ?? ''
    if (
      typeof expectedSecret !== 'string' ||
      !(await constantTimeEqual(candidateSecret, expectedSecret))
    ) {
      return error('NOT_FOUND', '요청한 API를 찾을 수 없습니다.')
    }

    const receivedAt = clock()
    let rawEnvelope: unknown
    let envelope: MoEnvelope
    try {
      const rawBody = await request.text()
      rawEnvelope = rawBody
      try {
        rawEnvelope = JSON.parse(rawBody)
      } catch (cause) {
        throw new PayloadValidationError(
          '요청 본문이 JSON 형식이 아닙니다.',
          { cause },
        )
      }
      envelope = parseEnvelope(rawEnvelope)
    } catch (cause) {
      if (!(cause instanceof PayloadValidationError)) {
        console.error('LGU+ MO 요청 본문을 읽지 못했습니다.', {
          error: failureText(cause),
        })
        return retryResponse()
      }

      try {
        const key = await syntheticFailureKey(
          rawEnvelope,
          INVALID_ENVELOPE_KEY_PREFIX,
        )
        const quarantined = await quarantineDeterministicFailure(
          env.DB,
          { key, raw: rawEnvelope, cause },
          receivedAt,
        )
        return quarantined ? successResponse() : retryResponse(400)
      } catch (failureCause) {
        console.error('LGU+ MO 본문 실패 격리 기록에 실패했습니다.', {
          error: failureText(failureCause),
        })
        return retryResponse()
      }
    }

    // 이 단계는 D1에 접근하지 않는다. 여기서 난 검증 오류만 독약으로 센다.
    const prepared: PreparedMo[] = []
    const failures = new Map<string, DeterministicFailure>()
    for (const [inputIndex, raw] of envelope.moLst.entries()) {
      try {
        prepared.push(prepareItem(raw, inputIndex))
      } catch (cause) {
        if (!(cause instanceof PayloadValidationError)) {
          console.error('LGU+ MO 순수 검증 중 내부 오류가 발생했습니다.', {
            error: failureText(cause),
          })
          return retryResponse()
        }

        try {
          const key = await itemFailureKey(raw)
          if (!failures.has(key)) failures.set(key, { key, raw, cause })
        } catch (hashCause) {
          console.error('LGU+ MO 격리 키 생성에 실패했습니다.', {
            error: failureText(hashCause),
          })
          return retryResponse()
        }
      }
    }

    let retryDeterministicFailure = false
    for (const failure of failures.values()) {
      try {
        const quarantined = await quarantineDeterministicFailure(
          env.DB,
          failure,
          receivedAt,
        )
        if (!quarantined) retryDeterministicFailure = true
      } catch (failureCause) {
        // 실패 기록 자체의 D1 오류는 인프라 오류다. 독약 횟수를 추정하지 않는다.
        console.error('LGU+ MO 유효성 실패 격리 기록에 실패했습니다.', {
          failureKey: failure.key,
          error: failureText(failureCause),
        })
        return retryResponse()
      }
    }

    prepared.sort(
      (left, right) =>
        left.occurredAt - right.occurredAt ||
        left.inputIndex - right.inputIndex,
    )

    for (const item of prepared) {
      try {
        await processItem(env, item, receivedAt, ctx)
      } catch (cause) {
        // 검증 뒤의 예외는 모두 일시적이다. LGU+ 재전송을 멈추면 안 된다.
        console.error('LGU+ MO D1 커밋에 실패했습니다.', {
          moKey: item.item.moKey,
          error: failureText(cause),
        })
        return retryResponse()
      }
    }

    return retryDeterministicFailure
      ? retryResponse(400)
      : successResponse()
  }
}

export const routes: Route[] = [
  {
    method: 'POST',
    path: '/api/hooks/lgu/mo/:secret',
    handler: createMoWebhookHandler(),
  },
]
