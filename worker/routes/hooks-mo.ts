import type { SendChannel } from '../../shared/domain'
import { SMS_MAX_BYTES, smsByteLength } from '../../shared/sms'
import { error } from '../http/error'
import { json } from '../http/respond'
import type { Route, RouteHandler } from '../http/router'
import {
  storeInboundMessage,
  type InboundAttachment,
} from '../inbound-message'
import type { Clock } from '../lib/ids'
import { normalizeKoreanPhoneValue } from '../lib/phone'
import { runAttachmentDownloads } from '../scheduled'

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000
const QUARANTINE_ATTEMPTS = 3
export const INVALID_ITEM_KEY_PREFIX = 'invalid-item-sha256:'
const INVALID_ENVELOPE_KEY_PREFIX = 'invalid-envelope-sha256:'
const SUCCESS_BODY = { code: '10000', message: 'success' } as const
const RETRY_BODY = { code: '99999', message: 'retry' } as const

type KnownMoType = 'SMSMO' | 'LMSMO' | 'MMSMO'

interface MoContent {
  contentName: string | null
  contentSize: number | null
  contentExt: string | null
  contentUrl: string | null
}

interface MoItem {
  moKey: string
  moNumber: string | null
  moType: string
  moCallback: string
  moMsg: string
  moRecvDt: string
  contentInfoLst: MoContent[]
}

interface MoEnvelope {
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
  office_channel_id: string | null
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

/**
 * 문서는 SMSMO·MMSMO·RCSMO만 적었으나 운영에서 LMSMO가 왔다.
 * 목록이 완전하지 않으니 모르는 값을 버리지 않는다.
 * RCS는 이 사무소가 쓰지 않아 명시하지 않는다. 오면 모르는 타입 규칙을 탄다.
 */
const MO_CHANNEL: Record<KnownMoType, SendChannel> = {
  SMSMO: 'SMS',
  LMSMO: 'LMS',
  MMSMO: 'MMS',
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

function isKnownMoType(value: string): value is KnownMoType {
  return Object.hasOwn(MO_CHANNEL, value)
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

function nullableString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nullableNonNegativeInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : value

  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    return null
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
    contentName: nullableString(value, 'contentName'),
    contentSize: nullableNonNegativeInteger(value.contentSize),
    contentExt: nullableString(value, 'contentExt'),
    contentUrl: nullableString(value, 'contentUrl'),
  }
}

function parseItem(value: unknown): MoItem {
  if (!isRecord(value)) {
    throw new PayloadValidationError('moLst 항목이 올바르지 않습니다.')
  }

  const moType = value.moType
  if (typeof moType !== 'string' || moType.length === 0) {
    throw new PayloadValidationError('moType 값이 올바르지 않습니다.')
  }

  const rawContentInfoLst = value.contentInfoLst
  if (
    rawContentInfoLst !== undefined &&
    rawContentInfoLst !== null &&
    !Array.isArray(rawContentInfoLst)
  ) {
    throw new PayloadValidationError('contentInfoLst 값이 올바르지 않습니다.')
  }

  const contentInfoLst = rawContentInfoLst?.map(parseContent) ?? []

  return {
    moKey: requiredString(value, 'moKey'),
    moNumber: nullableString(value, 'moNumber'),
    moType,
    moCallback: requiredString(value, 'moCallback'),
    moMsg: typeof value.moMsg === 'string' ? value.moMsg : '',
    moRecvDt: requiredString(value, 'moRecvDt'),
    contentInfoLst,
  }
}

function parseEnvelope(value: unknown): MoEnvelope {
  if (!isRecord(value) || !Array.isArray(value.moLst)) {
    throw new PayloadValidationError('MO 페이로드가 올바르지 않습니다.')
  }

  return { moLst: value.moLst }
}

/**
 * LGU+의 KST yyyyMMddHHmmss 또는 ISO 지역시각을 epoch 밀리초로 바꾼다.
 * 범위를 벗어난 날짜는 Date의 자동 보정을 허용하지 않고 거부한다.
 */
export function parseMoRecvDt(value: string): number | null {
  const compactValue = value.replace(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/,
    '$1$2$3$4$5$6',
  )
  const match =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(compactValue)
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
  const normalized = normalizeKoreanPhoneValue(value)
  if (normalized !== null) return normalized

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

function originalFilename(content: MoContent): string | null {
  if (content.contentName === null) return null
  if (content.contentExt === null) return content.contentName

  const extension = content.contentExt.replace(/^\./, '')
  const suffix = `.${extension}`.toLocaleLowerCase('en-US')
  return content.contentName.toLocaleLowerCase('en-US').endsWith(suffix)
    ? content.contentName
    : `${content.contentName}.${extension}`
}

function mimeType(content: MoContent): string | null {
  if (content.contentExt === null) return null

  const extension = content.contentExt.replace(/^\./, '').toLowerCase()
  return MIME_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

function messageChannel(item: MoItem): SendChannel {
  if (isKnownMoType(item.moType)) return MO_CHANNEL[item.moType]
  if (item.contentInfoLst.length > 0) return 'MMS'
  return smsByteLength(item.moMsg) <= SMS_MAX_BYTES ? 'SMS' : 'LMS'
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
    channel: messageChannel(item),
  }
}

async function findOffice(db: D1Database): Promise<OfficeRow> {
  const office = await db
    .prepare(
      `SELECT
         offices.id,
         office_channels.id AS office_channel_id
       FROM offices
       LEFT JOIN office_channels
         ON office_channels.office_id = offices.id
         AND office_channels.is_default = 1
       ORDER BY offices.created_at, offices.id
       LIMIT 1`,
    )
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

async function storePreparedItem(
  env: Env,
  prepared: PreparedMo,
  receivedAt: number,
  ctx?: ExecutionContext,
): Promise<void> {
  const { item, occurredAt, channel, phoneE164 } = prepared
  const office = await findOffice(env.DB)
  if (office.office_channel_id === null) {
    throw new Error('LGU+ MO를 귀속할 기본 업무폰이 없습니다.')
  }

  console.info('LGU+ MO 수신 채널을 저장 채널로 매핑합니다.', {
    moKey: item.moKey,
    moType: item.moType,
    storedChannel: channel,
  })
  if (!isKnownMoType(item.moType)) {
    console.warn('알 수 없는 LGU+ MO 타입을 추론한 채널로 저장합니다.', {
      moKey: item.moKey,
      moType: item.moType,
      storedChannel: channel,
    })
  }

  const attachments: InboundAttachment[] = item.contentInfoLst.map(
    (content) => ({
      originalFilename: originalFilename(content),
      byteSize: content.contentSize,
      mimeType: mimeType(content),
      contentUrl: content.contentUrl,
    }),
  )
  await storeInboundMessage(
    env,
    {
      officeId: office.id,
      officeChannelId: office.office_channel_id,
      customerPhoneE164: phoneE164,
      channel,
      title: null,
      body: item.moMsg,
      occurredAt,
      receivedAt,
      idempotencyKey: item.moKey,
      attachments,
      eventMetadata: {
        moType: item.moType,
        moNumber: item.moNumber,
      },
    },
    ctx,
  )
}

type AttachmentDownloadStarter = (
  env: Env,
  ctx?: ExecutionContext,
) => Promise<unknown>

const startAttachmentDownloads: AttachmentDownloadStarter = (env, ctx) =>
  runAttachmentDownloads(env, {}, ctx)

export function createMoWebhookHandler(
  clock: Clock = Date.now,
  downloadAttachments: AttachmentDownloadStarter =
    startAttachmentDownloads,
): RouteHandler {
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
        await storePreparedItem(env, item, receivedAt, ctx)
      } catch (cause) {
        // 검증 뒤의 예외는 모두 일시적이다. LGU+ 재전송을 멈추면 안 된다.
        console.error('LGU+ MO D1 커밋에 실패했습니다.', {
          moKey: item.item.moKey,
          error: failureText(cause),
        })
        return retryResponse()
      }
    }

    if (
      ctx !== undefined &&
      prepared.some(({ item }) => item.contentInfoLst.length > 0)
    ) {
      try {
        ctx.waitUntil(
          Promise.resolve()
            .then(() => downloadAttachments(env, ctx))
            .catch((cause) => {
              console.error('MO 첨부 즉시 다운로드에 실패했습니다.', {
                error: failureText(cause),
              })
            }),
        )
      } catch (cause) {
        // 다운로드 시작 실패는 이미 커밋된 MO의 성공 응답을 막지 않는다.
        console.error('MO 첨부 다운로드 예약에 실패했습니다.', {
          error: failureText(cause),
        })
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
