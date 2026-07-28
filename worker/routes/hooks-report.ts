import type {
  DeliveryReport,
  ReportDeliveryStatus,
} from '../db/delivery'
import { applyDeliveryReports } from '../db/delivery'
import { error } from '../http/error'
import { json } from '../http/respond'
import type { Route, RouteHandler } from '../http/router'
import { LGU_SUCCESS_CODE } from '../lgu/protocol'
import { parseLguReportDateTime } from '../lgu/report'
import type { Clock } from '../lib/ids'

const SUCCESS_BODY = {
  code: LGU_SUCCESS_CODE,
  message: 'success',
} as const
const RETRY_BODY = { code: '99999', message: 'retry' } as const
const ERROR_TEXT_MAX_LENGTH = 500

type WebhookReportStatus = 'REG' | 'ING' | 'DONE'
type WebhookTarget = ReportDeliveryStatus | '결과'

interface ReportLogger {
  error(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
}

interface WebhookReportItem {
  cliKey?: unknown
  msgKey?: unknown
  resultCode?: unknown
  resultCodeDesc?: unknown
  rptDt?: unknown
  status?: unknown
}

interface RejectedReport {
  msgKey: string | null
  reason: string
  status: unknown
}

const WEBHOOK_TARGET: Record<WebhookReportStatus, WebhookTarget> = {
  REG: '접수',
  ING: '전송중',
  DONE: '결과',
}

class PayloadValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PayloadValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function stringValue(value: unknown): string | null {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    String(value).trim() === ''
  ) {
    return null
  }
  return String(value)
}

function webhookTarget(value: unknown): WebhookTarget | null {
  if (value === undefined) return '결과'
  return typeof value === 'string' &&
    Object.hasOwn(WEBHOOK_TARGET, value)
    ? WEBHOOK_TARGET[value as WebhookReportStatus]
    : null
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    ),
  )
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

function successResponse(): Response {
  return json(SUCCESS_BODY)
}

function retryResponse(status = 500): Response {
  return json(RETRY_BODY, { status })
}

function rejected(
  item: WebhookReportItem,
  reason: string,
): RejectedReport {
  return {
    msgKey: stringValue(item.msgKey),
    status: item.status ?? item.resultCode,
    reason,
  }
}

function parseItem(
  raw: unknown,
  receivedAt: number,
): DeliveryReport | RejectedReport {
  if (!isRecord(raw)) {
    return {
      msgKey: null,
      status: null,
      reason: '리포트 항목이 객체가 아닙니다.',
    }
  }

  const item = raw as WebhookReportItem
  const msgKey = stringValue(item.msgKey)
  if (msgKey === null) {
    return rejected(item, 'msgKey가 없거나 형식이 올바르지 않습니다.')
  }

  const target = webhookTarget(item.status)
  if (target === null) {
    return rejected(item, '알 수 없는 메시지 상태입니다.')
  }

  const clientKey = stringValue(item.cliKey)
  const resultCode = stringValue(item.resultCode)
  if (target === '결과' && resultCode === null) {
    return rejected(item, 'resultCode가 없거나 형식이 올바르지 않습니다.')
  }

  const reportTime =
    target === '결과'
      ? parseLguReportDateTime(item.rptDt)
      : null
  if (target === '결과' && reportTime === null) {
    return rejected(item, 'rptDt 형식이 올바르지 않습니다.')
  }

  const status =
    target === '결과'
      ? resultCode === LGU_SUCCESS_CODE
        ? '완료'
        : '실패'
      : target
  const resultDescription = stringValue(item.resultCodeDesc)
  const errorText =
    status === '실패'
      ? (
          resultDescription ??
          `LGU+ 전송 실패 (${resultCode ?? 'UNKNOWN'})`
        ).slice(0, ERROR_TEXT_MAX_LENGTH)
      : null

  return {
    clientKey,
    deliveredAt: status === '완료' ? reportTime : null,
    errorText,
    eventAt: receivedAt,
    msgKey,
    resultCode:
      status === '접수' || status === '전송중'
        ? null
        : resultCode,
    status,
  }
}

function parseEnvelope(
  raw: unknown,
  receivedAt: number,
  logger: ReportLogger,
): DeliveryReport[] {
  if (!isRecord(raw) || !Array.isArray(raw.rptLst)) {
    throw new PayloadValidationError(
      'rptLst 배열이 없는 리포트 본문입니다.',
    )
  }

  if (
    !Number.isSafeInteger(raw.rptCnt) ||
    raw.rptCnt !== raw.rptLst.length
  ) {
    logger.warn('LGU+ 리포트 개수가 본문과 일치하지 않습니다.', {
      declaredCount: raw.rptCnt,
      receivedCount: raw.rptLst.length,
    })
  }

  const reports: DeliveryReport[] = []
  for (const item of raw.rptLst) {
    const parsed = parseItem(item, receivedAt)
    if ('reason' in parsed) {
      logger.warn('결정적으로 잘못된 LGU+ 리포트 항목을 격리합니다.', {
        msgKey: parsed.msgKey,
        receivedStatus: parsed.status,
        reason: parsed.reason,
      })
      continue
    }
    reports.push(parsed)
  }
  return reports
}

export function createReportWebhookHandler(
  clock: Clock = Date.now,
  logger: ReportLogger = console,
): RouteHandler {
  return async (request, env, params, ctx) => {
    const expectedSecret = env.LGU_REPORT_WEBHOOK_SECRET
    if (
      typeof expectedSecret !== 'string' ||
      !(await constantTimeEqual(params.secret ?? '', expectedSecret))
    ) {
      return error('NOT_FOUND', '요청한 API를 찾을 수 없습니다.')
    }

    let rawBody: string
    try {
      rawBody = await request.text()
    } catch (cause) {
      logger.error('LGU+ 리포트 요청 본문을 읽지 못했습니다.', cause)
      return retryResponse()
    }

    let raw: unknown
    try {
      raw = JSON.parse(rawBody)
    } catch (cause) {
      logger.warn('결정적으로 잘못된 LGU+ 리포트 본문을 격리합니다.', {
        msgKey: null,
        receivedStatus: null,
        reason: '요청 본문이 JSON 형식이 아닙니다.',
        errorName: cause instanceof Error ? cause.name : 'UnknownError',
      })
      return successResponse()
    }

    let reports: DeliveryReport[]
    try {
      reports = parseEnvelope(raw, clock(), logger)
    } catch (cause) {
      if (!(cause instanceof PayloadValidationError)) {
        logger.error('LGU+ 리포트 순수 검증 중 오류가 발생했습니다.', cause)
        return retryResponse()
      }
      logger.warn('결정적으로 잘못된 LGU+ 리포트 본문을 격리합니다.', {
        msgKey: null,
        receivedStatus: null,
        reason: cause.message,
      })
      return successResponse()
    }

    try {
      const summary = await applyDeliveryReports(env.DB, reports, {
        ctx,
        env,
      })
      if (summary.unknown.length > 0) {
        logger.warn('아직 결합되지 않은 LGU+ 리포트를 재요청합니다.', {
          reportKeys: summary.unknown,
        })
        return retryResponse(400)
      }
      return successResponse()
    } catch (cause) {
      logger.error('LGU+ 리포트 D1 커밋에 실패했습니다.', cause)
      return retryResponse()
    }
  }
}

export const routes: Route[] = [
  {
    method: 'POST',
    path: '/api/hooks/lgu/report/:secret',
    handler: createReportWebhookHandler(),
  },
]
