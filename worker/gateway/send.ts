import type { DeliveryStatus } from '../../shared/domain'

export const SMS_GATEWAY_SEND_TIMEOUT_MS = 3_000

const GATEWAY_STATES = [
  'Pending',
  'Processed',
  'Sent',
  'Delivered',
  'Failed',
] as const

export type GatewayState = (typeof GATEWAY_STATES)[number]
type OutboundDeliveryStatus = Exclude<DeliveryStatus, '수신'>

const GATEWAY_DELIVERY_STATUS = {
  Pending: '대기',
  Processed: '접수',
  Sent: '전송중',
  Delivered: '완료',
  Failed: '실패',
} as const satisfies Record<GatewayState, OutboundDeliveryStatus>

interface GatewayRecipient {
  error?: unknown
  phoneNumber?: unknown
  state?: unknown
}

interface GatewayResponse {
  deviceId?: unknown
  id?: unknown
  recipients?: unknown
  state?: unknown
}

export interface GatewaySendInput {
  body: string
  clientKey: string
  deviceId: string
  phoneE164: string
  timeoutMs?: number
}

export interface ConfirmedGatewaySendResult {
  kind: 'confirmed'
  code: string
  deliveryStatus: OutboundDeliveryStatus
  errorText: string | null
}

interface UncertainGatewaySendResult {
  kind: 'uncertain'
}

export type GatewaySendResult =
  | ConfirmedGatewaySendResult
  | UncertainGatewaySendResult

class GatewayConfigurationError extends Error {
  constructor(binding: string, options?: ErrorOptions) {
    super(`SMS Gateway 필수 바인딩 ${binding}이(가) 설정되지 않았습니다.`, options)
    this.name = 'GatewayConfigurationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function requiredBinding(
  value: unknown,
  binding: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatewayConfigurationError(binding)
  }
  return value
}

function gatewayMessagesUrl(rawBaseUrl: string): string {
  let baseUrl: URL
  try {
    baseUrl = new URL(rawBaseUrl)
  } catch (cause) {
    throw new GatewayConfigurationError(
      'SMS_GATEWAY_API_URL',
      { cause },
    )
  }

  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new GatewayConfigurationError('SMS_GATEWAY_API_URL')
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`
  baseUrl.search = ''
  baseUrl.hash = ''
  return new URL('messages', baseUrl).toString()
}

function basicAuthorization(
  username: string,
  password: string,
): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

function gatewayState(value: unknown): GatewayState | null {
  return (
    typeof value === 'string' &&
    Object.hasOwn(GATEWAY_DELIVERY_STATUS, value)
  )
    ? (value as GatewayState)
    : null
}

export function gatewayDeliveryStatus<State extends GatewayState>(
  state: State,
): (typeof GATEWAY_DELIVERY_STATUS)[State] {
  return GATEWAY_DELIVERY_STATUS[state]
}

function errorDescription(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim()
  }
  if (!isRecord(value)) return null

  for (const key of ['message', 'error', 'detail']) {
    const description = value[key]
    if (typeof description === 'string' && description.trim() !== '') {
      return description.trim()
    }
  }
  return null
}

function failureText(
  code: string,
  description: string | null,
): string {
  return description === null
    ? `SMS Gateway가 발송을 거절했습니다. (${code})`
    : `SMS Gateway 발송 실패 (${code}): ${description}`
}

function confirmedFailure(
  code: string,
  description: string | null,
): ConfirmedGatewaySendResult {
  return {
    kind: 'confirmed',
    code,
    deliveryStatus: '실패',
    errorText: failureText(code, description),
  }
}

function parseGatewayResponse(
  value: unknown,
  input: GatewaySendInput,
): GatewaySendResult {
  if (!isRecord(value)) return { kind: 'uncertain' }

  const response = value as GatewayResponse
  if (
    response.id !== input.clientKey ||
    response.deviceId !== input.deviceId ||
    !Array.isArray(response.recipients) ||
    response.recipients.length !== 1
  ) {
    return { kind: 'uncertain' }
  }

  const recipient = response.recipients[0]
  if (
    !isRecord(recipient) ||
    recipient.phoneNumber !== input.phoneE164
  ) {
    return { kind: 'uncertain' }
  }

  const recipientResult = recipient as GatewayRecipient
  const state = gatewayState(recipientResult.state)
  if (state === null || gatewayState(response.state) === null) {
    return { kind: 'uncertain' }
  }

  if (state === 'Failed') {
    return confirmedFailure(
      state,
      errorDescription(recipientResult.error),
    )
  }

  return {
    kind: 'confirmed',
    code: state,
    deliveryStatus: gatewayDeliveryStatus(state),
    errorText: null,
  }
}

async function responseValue(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function sendGatewayTextMessage(
  env: Env,
  input: GatewaySendInput,
): Promise<GatewaySendResult> {
  let url: string
  let authorization: string
  let accessClientId: string
  let accessClientSecret: string
  try {
    url = gatewayMessagesUrl(
      requiredBinding(
        env.SMS_GATEWAY_API_URL,
        'SMS_GATEWAY_API_URL',
      ),
    )
    authorization = basicAuthorization(
      requiredBinding(
        env.SMS_GATEWAY_USERNAME,
        'SMS_GATEWAY_USERNAME',
      ),
      requiredBinding(
        env.SMS_GATEWAY_PASSWORD,
        'SMS_GATEWAY_PASSWORD',
      ),
    )
    accessClientId = requiredBinding(
      env.CF_ACCESS_CLIENT_ID,
      'CF_ACCESS_CLIENT_ID',
    )
    accessClientSecret = requiredBinding(
      env.CF_ACCESS_CLIENT_SECRET,
      'CF_ACCESS_CLIENT_SECRET',
    )
  } catch (cause) {
    if (cause instanceof GatewayConfigurationError) {
      return confirmedFailure('CONFIGURATION_ERROR', cause.message)
    }
    return { kind: 'uncertain' }
  }

  let response: Response
  try {
    // workerd의 전역 fetch는 객체 속성으로 보관하면 Illegal invocation이 난다.
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'CF-Access-Client-Id': accessClientId,
        'CF-Access-Client-Secret': accessClientSecret,
      },
      body: JSON.stringify({
        id: input.clientKey,
        deviceId: input.deviceId,
        textMessage: { text: input.body },
        phoneNumbers: [input.phoneE164],
        simNumber: 1,
        withDeliveryReport: true,
      }),
      signal: AbortSignal.timeout(
        input.timeoutMs ?? SMS_GATEWAY_SEND_TIMEOUT_MS,
      ),
    })
  } catch {
    return { kind: 'uncertain' }
  }

  let value: unknown
  try {
    value = await responseValue(response)
  } catch {
    return { kind: 'uncertain' }
  }
  if (!response.ok) {
    return confirmedFailure(
      `HTTP_${response.status}`,
      errorDescription(value),
    )
  }
  return parseGatewayResponse(value, input)
}
