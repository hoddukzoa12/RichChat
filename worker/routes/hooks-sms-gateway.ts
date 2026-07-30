import { error } from '../http/error'
import type { Route, RouteHandler } from '../http/router'
import { storeInboundMessage } from '../inbound-message'
import type { Clock } from '../lib/ids'
import { normalizeKoreanPhoneValue } from '../lib/phone'

const SIGNATURE_HEADER = 'X-Signature'
const TIMESTAMP_HEADER = 'X-Timestamp'
const SMS_RECEIVED_EVENT = 'sms:received'

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

/**
 * 오프셋이 명시된 ISO 8601 지역 시각만 받는다.
 * Date의 잘못된 날짜 자동 보정을 피하려고 지역 시각 구성요소를 먼저 검증한다.
 */
export function parseGatewayReceivedAt(value: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
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
    offsetText,
  ] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const millisecond = Number(millisecondText.padEnd(3, '0'))

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

  if (offsetText === 'Z') return local.getTime()

  const sign = offsetText.startsWith('+') ? 1 : -1
  const offsetHours = Number(offsetText.slice(1, 3))
  const offsetMinutes = Number(offsetText.slice(4, 6))
  if (offsetHours > 23 || offsetMinutes > 59) return null

  return (
    local.getTime() -
    sign * (offsetHours * 60 + offsetMinutes) * 60 * 1_000
  )
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
    if (event !== SMS_RECEIVED_EVENT) return successResponse()

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
