import {
  LguApiError,
  requestLgu,
  type LguHttpEnv,
} from './http'
import { LGU_SUCCESS_CODE } from './protocol'
import { LguConfigurationError } from './token'

export type OutboundTextChannel = 'SMS' | 'LMS'

export interface AcceptedSendResult {
  kind: 'accepted'
  code: string
  msgKey: string
}

export interface RejectedSendResult {
  kind: 'rejected'
  code: string
  errorText: string
}

interface UncertainSendResult {
  kind: 'uncertain'
}

export type ConfirmedSendResult =
  | AcceptedSendResult
  | RejectedSendResult
export type LguSendResult = ConfirmedSendResult | UncertainSendResult

export type LguRequest = <T>(
  env: LguHttpEnv,
  officeId: string,
  service: 'send',
  path: string,
  init: RequestInit,
) => Promise<T>

interface LguRecipientResult {
  cliKey?: unknown
  msgKey?: unknown
  code?: unknown
  message?: unknown
}

interface LguSendResponse {
  data?: unknown
}

interface SendTextInput {
  body: string
  callback: string
  channel: OutboundTextChannel
  officeId: string
  phone: string
  providerKey: string
  timeoutMs?: number
}

const LGU_SEND_PATH: Record<OutboundTextChannel, string> = {
  SMS: '/msg/v1/sms',
  LMS: '/msg/v1/mms',
}
export const LGU_SEND_TIMEOUT_MS = 3_000
const ERROR_TEXT_MAX_LENGTH = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function requestBody(
  env: Env,
  input: SendTextInput,
): Record<string, unknown> {
  return {
    apiKey: env.LGU_API_KEY,
    callback: input.callback,
    msg: input.body,
    recvInfoLst: [
      {
        cliKey: input.providerKey,
        phone: input.phone,
        countryCd: '82',
        mergeData: {},
      },
    ],
  }
}

function safeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim().slice(0, ERROR_TEXT_MAX_LENGTH)
    : null
}

function rejectionText(code: string, message: unknown): string {
  const description = safeText(message)
  return (
    description === null
      ? `LGU+가 발송을 거절했습니다. (${code})`
      : `LGU+ 발송 거절 (${code}): ${description}`
  ).slice(0, ERROR_TEXT_MAX_LENGTH)
}

function parseResponse(
  response: LguSendResponse,
  providerKey: string,
): LguSendResult {
  if (!Array.isArray(response.data) || response.data.length !== 1) {
    return { kind: 'uncertain' }
  }

  const item = response.data[0]
  if (!isRecord(item)) return { kind: 'uncertain' }

  const result = item as LguRecipientResult
  if (
    result.cliKey !== providerKey ||
    (typeof result.code !== 'string' &&
      typeof result.code !== 'number')
  ) {
    return { kind: 'uncertain' }
  }

  const code = String(result.code)
  if (code !== LGU_SUCCESS_CODE) {
    return {
      kind: 'rejected',
      code,
      errorText: rejectionText(code, result.message),
    }
  }

  if (typeof result.msgKey !== 'string' || result.msgKey === '') {
    return { kind: 'uncertain' }
  }

  return {
    kind: 'accepted',
    code,
    msgKey: result.msgKey,
  }
}

function lguErrorMessage(cause: LguApiError): unknown {
  return isRecord(cause.body) ? cause.body.message : null
}

function classifyError(cause: unknown): LguSendResult {
  if (cause instanceof LguApiError) {
    if (cause.code === 'INVALID_RESPONSE' || cause.status >= 500) {
      return { kind: 'uncertain' }
    }

    return {
      kind: 'rejected',
      code: cause.code,
      errorText: rejectionText(cause.code, lguErrorMessage(cause)),
    }
  }

  if (cause instanceof LguConfigurationError) {
    return {
      kind: 'rejected',
      code: 'CONFIGURATION_ERROR',
      errorText: 'LGU+ 발송 설정을 확인할 수 없습니다.',
    }
  }

  return { kind: 'uncertain' }
}

export async function sendTextMessage(
  env: Env,
  input: SendTextInput,
  lguRequest: LguRequest = requestLgu,
): Promise<LguSendResult> {
  try {
    const response = await lguRequest<LguSendResponse>(
      env,
      input.officeId,
      'send',
      LGU_SEND_PATH[input.channel],
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody(env, input)),
        signal: AbortSignal.timeout(
          input.timeoutMs ?? LGU_SEND_TIMEOUT_MS,
        ),
      },
    )

    return parseResponse(response, input.providerKey)
  } catch (cause) {
    return classifyError(cause)
  }
}
