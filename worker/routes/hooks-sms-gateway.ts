import {
  applyDeliveryReports,
  DELIVERY_ERROR_TEXT_MAX_LENGTH,
  type DeliveryReport,
} from '../db/delivery'
import {
  gatewayDeliveryStatus,
  type GatewayState,
} from '../gateway/send'
import { error } from '../http/error'
import type { Route, RouteHandler } from '../http/router'
import { storeInboundMessage } from '../inbound-message'
import type { Clock } from '../lib/ids'
import { normalizeKoreanPhoneValue } from '../lib/phone'

const SIGNATURE_HEADER = 'X-Signature'
const TIMESTAMP_HEADER = 'X-Timestamp'
const SMS_RECEIVED_EVENT = 'sms:received'
const SMS_DELIVERY_EVENT = {
  'sms:sent': {
    gatewayState: 'Sent',
    timestampKey: 'sentAt',
  },
  'sms:delivered': {
    gatewayState: 'Delivered',
    timestampKey: 'deliveredAt',
  },
  'sms:failed': {
    gatewayState: 'Failed',
    timestampKey: 'failedAt',
  },
} as const satisfies Record<
  string,
  {
    gatewayState: Extract<
      GatewayState,
      'Sent' | 'Delivered' | 'Failed'
    >
    timestampKey: string
  }
>
type SmsDeliveryEvent = keyof typeof SMS_DELIVERY_EVENT

// 공식 문서가 재전송 공격 방어와 기기 시계 오차를 함께 고려해 ±5분을 권고한다.
export const WEBHOOK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1_000

interface SmsReceivedPayload {
  messageId: string
  message: string
  sender: string
  recipient: string | null
  simNumber: number | null
  receivedAt: number
}

interface SmsReceivedEnvelope {
  deviceId: string
  payload: SmsReceivedPayload
}

interface OfficeChannelRow {
  id: string
  office_id: string
  signing_key: string | null
}

interface GatewayReportFailureRow {
  attempts: number
}

class GatewayPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GatewayPayloadError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayPayloadError(`${key} 값이 올바르지 않습니다.`)
  }
  return value
}

function messageString(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key]
  if (typeof value !== 'string') {
    throw new GatewayPayloadError(`${key} 값이 올바르지 않습니다.`)
  }
  return value
}

function nullableString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key]
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayPayloadError(`${key} 값이 올바르지 않습니다.`)
  }
  return value
}

function nullableSimNumber(value: unknown): number | null {
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new GatewayPayloadError(
      'simNumber 값이 올바르지 않습니다.',
    )
  }
  return value
}

function parseGatewayIsoDateTime(
  value: string,
  defaultOffsetMinutes: number | null,
): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      value,
    )
  if (!match) return null

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    millisecondText = '0',
    rawOffsetText,
  ] = match
  if (rawOffsetText === undefined && defaultOffsetMinutes === null) {
    return null
  }
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const millisecond = Number(
    millisecondText.padEnd(3, '0').slice(0, 3),
  )

  const local = new Date(0)
  local.setUTCFullYear(
    year,
    month - 1,
    day,
  )
  local.setUTCHours(hour, minute, second, millisecond)
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millisecond
  ) {
    return null
  }

  if (rawOffsetText === 'Z') return local.getTime()

  let offsetMinutes = defaultOffsetMinutes ?? 0
  if (rawOffsetText !== undefined) {
    const sign = rawOffsetText.startsWith('+') ? 1 : -1
    const offsetHours = Number(rawOffsetText.slice(1, 3))
    const minuteStart = rawOffsetText.includes(':') ? 4 : 3
    const offsetMinutePart = Number(
      rawOffsetText.slice(minuteStart, minuteStart + 2),
    )
    if (offsetHours > 23 || offsetMinutePart > 59) return null
    offsetMinutes =
      sign * (offsetHours * 60 + offsetMinutePart)
  }

  return local.getTime() - offsetMinutes * 60 * 1_000
}

/**
 * 수신 메시지는 기기 앱 계약대로 오프셋이 명시된 ISO 8601 시각만 받는다.
 * Date의 잘못된 날짜 자동 보정을 피하려고 지역 시각 구성요소를 먼저 검증한다.
 */
export function parseGatewayReceivedAt(value: string): number | null {
  return parseGatewayIsoDateTime(value, null)
}

function parseEpoch(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' &&
          /^-?\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(numeric)) return null

  const milliseconds =
    Math.abs(numeric) < 100_000_000_000
      ? numeric * 1_000
      : numeric
  const rounded = Math.round(milliseconds)
  return Number.isSafeInteger(rounded) &&
    !Number.isNaN(new Date(rounded).getTime())
    ? rounded
    : null
}

/**
 * 실제 게이트웨이 시각 형식을 아직 관측하지 못했으므로 epoch 초·밀리초와
 * ISO 8601을 함께 받는다. 오프셋 없는 지역 시각은 업무폰의 KST로 해석한다.
 */
export function parseGatewayReportAt(value: unknown): number | null {
  const epoch = parseEpoch(value)
  if (epoch !== null) return epoch
  if (typeof value !== 'string') return null
  return parseGatewayIsoDateTime(value.trim(), 9 * 60)
}

function parseSmsReceivedEnvelope(
  envelope: Record<string, unknown>,
  deviceId: string,
): SmsReceivedEnvelope {
  const rawPayload = envelope.payload
  if (!isRecord(rawPayload)) {
    throw new GatewayPayloadError('payload 값이 올바르지 않습니다.')
  }

  const receivedAtText = requiredString(rawPayload, 'receivedAt')
  const receivedAt = parseGatewayReceivedAt(receivedAtText)
  if (receivedAt === null) {
    throw new GatewayPayloadError(
      'receivedAt은 오프셋이 있는 ISO 8601 시각이어야 합니다.',
    )
  }

  return {
    deviceId,
    payload: {
      messageId: requiredString(rawPayload, 'messageId'),
      message: messageString(rawPayload, 'message'),
      sender: requiredString(rawPayload, 'sender'),
      recipient: nullableString(rawPayload, 'recipient'),
      simNumber: nullableSimNumber(rawPayload.simNumber),
      receivedAt,
    },
  }
}

function isSmsDeliveryEvent(value: string): value is SmsDeliveryEvent {
  return Object.hasOwn(SMS_DELIVERY_EVENT, value)
}

function reasonValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim()
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (!isRecord(value)) return null

  const code =
    typeof value.code === 'string' ||
    typeof value.code === 'number'
      ? String(value.code)
      : null
  let description: string | null = null
  for (const key of ['message', 'error', 'detail', 'reason']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      description = candidate.trim()
      break
    }
  }
  if (description !== null) {
    return code === null ? description : `${description} (${code})`
  }

  const serialized = JSON.stringify(value)
  return serialized === '{}' ? null : serialized
}

function gatewayFailureText(reason: unknown): string {
  const description =
    reasonValue(reason) ?? '원인을 확인할 수 없습니다.'
  return `SMS Gateway 발송 실패: ${description}`.slice(
    0,
    DELIVERY_ERROR_TEXT_MAX_LENGTH,
  )
}

function parseSmsDeliveryReport(
  envelope: Record<string, unknown>,
  event: SmsDeliveryEvent,
  receivedAt: number,
): DeliveryReport {
  const rawPayload = envelope.payload
  if (!isRecord(rawPayload)) {
    throw new GatewayPayloadError('payload 값이 올바르지 않습니다.')
  }

  const messageId = requiredString(rawPayload, 'messageId')
  const config = SMS_DELIVERY_EVENT[event]
  const reportAt = parseGatewayReportAt(
    rawPayload[config.timestampKey],
  )

  return {
    clientKey: messageId,
    deliveredAt: event === 'sms:delivered' ? reportAt : null,
    errorText:
      event === 'sms:failed'
        ? gatewayFailureText(rawPayload.reason)
        : null,
    // 시각 해석 실패는 상태 전이를 막지 않고 감사 이벤트에 수신 시각을 쓴다.
    eventAt: reportAt ?? receivedAt,
    msgKey: null,
    resultCode: config.gatewayState,
    status: gatewayDeliveryStatus(config.gatewayState),
  }
}

/**
 * 앱의 32비트 messageId는 기기 간 또는 다른 사업자의 키와 겹칠 수 있다.
 * 사업자와 deviceId를 함께 넣어 전역 mo_key 인덱스에서 네임스페이스를 분리한다.
 */
export function smsGatewayIdempotencyKey(
  deviceId: string,
  messageId: string,
): string {
  return `sms-gateway/${encodeURIComponent(deviceId)}/${encodeURIComponent(messageId)}`
}

function identifierValue(value: unknown): string | null {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    String(value).trim() === ''
  ) {
    return null
  }
  return String(value)
}

async function rawBodyDigest(rawBody: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(rawBody),
    ),
  )
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function gatewayReportFailureKey(
  envelope: Record<string, unknown>,
  deviceId: string,
  event: SmsDeliveryEvent,
  rawBody: string,
): Promise<string> {
  const payload = isRecord(envelope.payload)
    ? envelope.payload
    : {}
  const identifier =
    identifierValue(payload.messageId) ??
    identifierValue(envelope.id) ??
    identifierValue(envelope.webhookId) ??
    (await rawBodyDigest(rawBody))
  return [
    'sms-gateway-report',
    encodeURIComponent(deviceId),
    encodeURIComponent(event),
    encodeURIComponent(identifier),
  ].join('/')
}

async function recordGatewayReportFailure(
  db: D1Database,
  values: {
    errorText: string
    failureKey: string
    now: number
    rawBody: string
  },
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
      values.failureKey,
      values.rawBody,
      values.errorText.slice(0, 1_000),
      values.now,
      values.now,
    )
    .first<GatewayReportFailureRow>()
  if (failure === null) {
    throw new Error('SMS Gateway 리포트 원문을 격리하지 못했습니다.')
  }
  return failure.attempts
}

function decodeSignature(value: string): Uint8Array | null {
  const normalized = value.trim().toLowerCase()
  if (!/^[\da-f]{64}$/.test(normalized)) return null

  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      normalized.slice(index * 2, index * 2 + 2),
      16,
    )
  }
  return bytes
}

function constantTimeEqual(
  candidate: Uint8Array,
  expected: Uint8Array,
): boolean {
  if (candidate.length !== expected.length) return false

  let difference = 0
  for (let index = 0; index < expected.length; index += 1) {
    difference |= candidate[index] ^ expected[index]
  }
  return difference === 0
}

async function expectedSignature(
  signingKey: string,
  rawBody: string,
  timestamp: string,
): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${rawBody}${timestamp}`),
    ),
  )
}

async function authenticate(
  request: Request,
  signingKey: string,
  rawBody: string,
  now: number,
): Promise<boolean> {
  const timestamp = request.headers.get(TIMESTAMP_HEADER)
  const candidate = decodeSignature(
    request.headers.get(SIGNATURE_HEADER) ?? '',
  )
  if (
    timestamp === null ||
    candidate === null ||
    !/^\d+$/.test(timestamp)
  ) {
    return false
  }

  const timestampSeconds = Number(timestamp)
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(now - timestampSeconds * 1_000) >
      WEBHOOK_TIMESTAMP_WINDOW_MS
  ) {
    return false
  }

  const expected = await expectedSignature(
    signingKey,
    rawBody,
    timestamp,
  )
  return constantTimeEqual(candidate, expected)
}

function successResponse(): Response {
  return new Response(null, { status: 204 })
}

export function createSmsGatewayWebhookHandler(
  clock: Clock = Date.now,
): RouteHandler {
  return async (request, env, _params, ctx) => {
    const receivedAt = clock()
    let rawBody: string
    try {
      rawBody = await request.text()
    } catch {
      return error('BAD_REQUEST', '요청 본문을 읽을 수 없습니다.')
    }

    let rawEnvelope: unknown
    try {
      rawEnvelope = JSON.parse(rawBody)
    } catch {
      return error('BAD_REQUEST', '요청 본문이 JSON 형식이 아닙니다.')
    }
    if (!isRecord(rawEnvelope)) {
      return error('BAD_REQUEST', '웹훅 페이로드가 올바르지 않습니다.')
    }

    let deviceId: string
    try {
      deviceId = requiredString(rawEnvelope, 'deviceId')
    } catch (cause) {
      if (cause instanceof GatewayPayloadError) {
        return error('BAD_REQUEST', cause.message)
      }
      return error('INTERNAL_ERROR', '웹훅 처리에 실패했습니다.')
    }

    let officeChannel: OfficeChannelRow | null
    try {
      officeChannel = await env.DB
        .prepare(
          `SELECT id, office_id, signing_key
           FROM office_channels
           WHERE device_id = ?`,
        )
        .bind(deviceId)
        .first<OfficeChannelRow>()
    } catch (cause) {
      console.error('SMS Gateway 기기 채널 조회에 실패했습니다.', {
        deviceId,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return error('INTERNAL_ERROR', '웹훅 처리에 실패했습니다.')
    }
    if (
      officeChannel?.signing_key == null ||
      !(await authenticate(
        request,
        officeChannel.signing_key,
        rawBody,
        receivedAt,
      ))
    ) {
      return error('UNAUTHORIZED', '웹훅 서명이 올바르지 않습니다.')
    }

    const event = rawEnvelope.event
    if (typeof event !== 'string' || event.length === 0) {
      return error('BAD_REQUEST', 'event 값이 올바르지 않습니다.')
    }
    if (event !== SMS_RECEIVED_EVENT) {
      if (!isSmsDeliveryEvent(event)) {
        console.warn('처리하지 않는 SMS Gateway 이벤트를 건너뜁니다.', {
          deviceId,
          event,
          envelopeId: identifierValue(rawEnvelope.id),
          webhookId: identifierValue(rawEnvelope.webhookId),
        })
        return successResponse()
      }

      let report: DeliveryReport
      try {
        report = parseSmsDeliveryReport(
          rawEnvelope,
          event,
          receivedAt,
        )
      } catch (cause) {
        if (!(cause instanceof GatewayPayloadError)) {
          console.error(
            'SMS Gateway 발송 리포트 검증에 실패했습니다.',
            {
              deviceId,
              event,
              error:
                cause instanceof Error
                  ? cause.message
                  : String(cause),
            },
          )
          return error('INTERNAL_ERROR', '웹훅 처리에 실패했습니다.')
        }

        try {
          const failureKey = await gatewayReportFailureKey(
            rawEnvelope,
            deviceId,
            event,
            rawBody,
          )
          const attempts = await recordGatewayReportFailure(env.DB, {
            errorText: `${cause.name}: ${cause.message}`,
            failureKey,
            now: receivedAt,
            rawBody,
          })
          console.warn(
            '해석할 수 없는 SMS Gateway 발송 리포트를 격리했습니다.',
            {
              attempts,
              deviceId,
              event,
              failureKey,
              reason: cause.message,
            },
          )
          return successResponse()
        } catch (recordCause) {
          console.error(
            'SMS Gateway 발송 리포트 원문 격리에 실패했습니다.',
            {
              deviceId,
              event,
              error:
                recordCause instanceof Error
                  ? recordCause.message
                  : String(recordCause),
            },
          )
          return error('INTERNAL_ERROR', '웹훅 처리에 실패했습니다.')
        }
      }

      try {
        const summary = await applyDeliveryReports(
          env.DB,
          [report],
          { ctx, env },
        )
        if (summary.unknown.length > 0) {
          console.warn(
            '결합할 메시지가 없는 SMS Gateway 발송 리포트를 건너뜁니다.',
            {
              deviceId,
              event,
              messageIds: summary.unknown,
            },
          )
        }
        return successResponse()
      } catch (cause) {
        console.error(
          'SMS Gateway 발송 리포트 D1 커밋에 실패했습니다.',
          {
            deviceId,
            event,
            messageId: report.clientKey,
            error:
              cause instanceof Error ? cause.message : String(cause),
          },
        )
        return error('INTERNAL_ERROR', '웹훅 처리에 실패했습니다.')
      }
    }

    let received: SmsReceivedEnvelope
    let customerPhoneE164: string
    try {
      received = parseSmsReceivedEnvelope(rawEnvelope, deviceId)
      const normalized = normalizeKoreanPhoneValue(
        received.payload.sender,
      )
      if (normalized === null) {
        throw new GatewayPayloadError(
          'sender가 국내 전화번호 형식이 아닙니다.',
        )
      }
      customerPhoneE164 = normalized
    } catch (cause) {
      if (cause instanceof GatewayPayloadError) {
        return error('BAD_REQUEST', cause.message)
      }
      console.error('SMS Gateway 수신 페이로드 검증에 실패했습니다.', {
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return error('INTERNAL_ERROR', '웹훅 처리에 실패했습니다.')
    }

    try {
      await storeInboundMessage(
        env,
        {
          officeId: officeChannel.office_id,
          officeChannelId: officeChannel.id,
          customerPhoneE164,
          channel: 'SMS',
          title: null,
          body: received.payload.message,
          occurredAt: received.payload.receivedAt,
          receivedAt,
          idempotencyKey: smsGatewayIdempotencyKey(
            received.deviceId,
            received.payload.messageId,
          ),
          eventMetadata: {
            deviceId: received.deviceId,
            recipient: received.payload.recipient,
            simNumber: received.payload.simNumber,
          },
        },
        ctx,
      )
    } catch (cause) {
      console.error('SMS Gateway 수신 메시지 D1 커밋에 실패했습니다.', {
        messageId: received.payload.messageId,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return error('INTERNAL_ERROR', '웹훅 처리에 실패했습니다.')
    }

    return successResponse()
  }
}

export const routes: Route[] = [
  {
    method: 'POST',
    path: '/api/hooks/sms-gateway',
    handler: createSmsGatewayWebhookHandler(),
  },
]
