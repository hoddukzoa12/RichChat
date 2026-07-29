import {
  LguApiError,
  requestLgu,
  type LguRequest,
} from './http'
import { LGU_SUCCESS_CODE } from './protocol'
import { LguConfigurationError } from './token'

export type OutboundChannel = 'SMS' | 'LMS' | 'MMS'

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

export type { LguRequest } from './http'

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
  channel: OutboundChannel
  fileIds?: string[]
  officeId: string
  phone: string
  providerKey: string
  timeoutMs?: number
}

const LGU_SEND_PATH: Record<OutboundChannel, string> = {
  SMS: '/msg/v1/sms',
  LMS: '/msg/v1/mms',
  // 발신번호 등록 전이라 MMS 실발송은 미검증이다.
  // 동작 중인 msg 계열의 LMS 경로를 유지한다.
  MMS: '/msg/v1/mms',
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
    ...(input.fileIds && input.fileIds.length > 0
      ? { fileIdLst: input.fileIds }
      : {}),
    // 컴포저에 제목 입력이 없으므로 title은 보내지 않는다.
    // 본문에서 파생하면 UI에 없는 두 번째 콘텐츠가 생긴다.
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
