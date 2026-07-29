import type {
  DeliveryReport,
  ReportDeliveryStatus,
} from '../db/delivery'
import { fetchLgu } from './access'
import {
  fetchLguJson,
  LGU_SUCCESS_CODE,
  type LguFetch,
} from './protocol'
import {
  getLguAccessToken,
  type LguTokenEnv,
  type LguTokenProvider,
} from './token'

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000
const ERROR_TEXT_MAX_LENGTH = 500

type LguReportStatus =
  | 'REG'
  | 'ING'
  | 'DONE'
  | 'OVER_DATE'
  | 'INVALID_KEY'

type PollTarget = ReportDeliveryStatus | '결과'

interface LguReportItem {
  cliKey?: unknown
  msgKey?: unknown
  resultCode?: unknown
  resultCodeDesc?: unknown
  rptDt?: unknown
  status?: unknown
}

interface LguReportResponse {
  data?: unknown
}

interface ReportQueryEnv extends LguTokenEnv {
  LGU_AUTH_HOST: string
}

export interface PendingReportQuery {
  clientKey: string
  requestedAt: number
}

export interface RejectedLguReport {
  msgKey: string | null
  reason: string
  status: unknown
}

export interface LguReportQueryResult {
  rejected: RejectedLguReport[]
  reports: DeliveryReport[]
}

interface LguReportQueryOptions {
  fetch?: LguFetch
  now?: () => number
  tokenProvider?: LguTokenProvider
}

const POLL_TARGET: Record<LguReportStatus, PollTarget> = {
  REG: '접수',
  ING: '전송중',
  DONE: '결과',
  OVER_DATE: '실패',
  INVALID_KEY: '실패',
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

function isLguReportStatus(value: unknown): value is LguReportStatus {
  return typeof value === 'string' && Object.hasOwn(POLL_TARGET, value)
}

function localKstTimestamp(value: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match
  const parts = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number)
  const [year, month, day, hour, minute, second] = parts
  const epoch =
    Date.UTC(year, month - 1, day, hour, minute, second) -
    KST_OFFSET_MS
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

export function parseLguReportDateTime(value: unknown): number | null {
  if (typeof value !== 'string') return null

  const local = localKstTimestamp(value)
  if (local !== null) return local

  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) ? epoch : null
}

export function lguRequestDate(epoch: number): string {
  return new Date(epoch + KST_OFFSET_MS).toISOString().slice(0, 10)
}

function parseItem(
  raw: unknown,
  eventAt: number,
): DeliveryReport | RejectedLguReport {
  if (!isRecord(raw)) {
    return {
      msgKey: null,
      status: null,
      reason: '리포트 항목이 객체가 아닙니다.',
    }
  }

  const item = raw as LguReportItem
  const msgKey = stringValue(item.msgKey)
  const clientKey = stringValue(item.cliKey)
  if (clientKey === null) {
    return {
      msgKey,
      status: item.status,
      reason: 'cliKey가 없거나 형식이 올바르지 않습니다.',
    }
  }
  if (!isLguReportStatus(item.status)) {
    return {
      msgKey,
      status: item.status,
      reason: '알 수 없는 메시지 상태입니다.',
    }
  }

  const target = POLL_TARGET[item.status]
  const resultCode = stringValue(item.resultCode)
  const resultDescription = stringValue(item.resultCodeDesc)
  let status: ReportDeliveryStatus

  if (target === '결과') {
    if (resultCode === null) {
      return {
        msgKey,
        status: item.status,
        reason: '완료 리포트에 resultCode가 없습니다.',
      }
    }
    status = resultCode === LGU_SUCCESS_CODE ? '완료' : '실패'
  } else {
    status = target
  }

  const requiresReportTime = item.status === 'DONE'
  const reportTime = requiresReportTime
    ? parseLguReportDateTime(item.rptDt)
    : null
  if (requiresReportTime && reportTime === null) {
    return {
      msgKey,
      status: item.status,
      reason: '완료 리포트의 rptDt 형식이 올바르지 않습니다.',
    }
  }

  const failureCode = resultCode ?? item.status
  const errorText =
    status === '실패'
      ? (
          resultDescription ??
          `LGU+ 결과를 실패로 확정했습니다. (${failureCode})`
        ).slice(0, ERROR_TEXT_MAX_LENGTH)
      : null

  return {
    clientKey,
    deliveredAt: status === '완료' ? reportTime : null,
    errorText,
    eventAt,
    msgKey,
    resultCode:
      status === '접수' || status === '전송중'
        ? null
        : failureCode,
    status,
  }
}

function parseResponse(
  response: LguReportResponse,
  eventAt: number,
): LguReportQueryResult {
  if (!isRecord(response.data) || !Array.isArray(response.data.cliKeyLst)) {
    throw new TypeError('LGU+ 리포트 조회 응답 형식이 올바르지 않습니다.')
  }

  const result: LguReportQueryResult = {
    rejected: [],
    reports: [],
  }
  for (const raw of response.data.cliKeyLst) {
    const parsed = parseItem(raw, eventAt)
    if ('reason' in parsed) {
      result.rejected.push(parsed)
    } else {
      result.reports.push(parsed)
    }
  }
  return result
}

export async function queryLguDeliveryReports(
  env: ReportQueryEnv,
  officeId: string,
  pending: readonly PendingReportQuery[],
  options: LguReportQueryOptions = {},
): Promise<LguReportQueryResult> {
  if (pending.length === 0) {
    return { rejected: [], reports: [] }
  }

  const fetcher = options.fetch ?? fetch
  const tokenProvider = options.tokenProvider ?? getLguAccessToken
  const eventAt = (options.now ?? Date.now)()
  const accessToken = await tokenProvider(env, officeId)
  const response = await fetchLguJson<LguReportResponse>(
    (input, init) => fetchLgu(env, fetcher, input, init),
    new URL('/msg/v1/sent', `https://${env.LGU_AUTH_HOST}`).toString(),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        cliKeyLst: pending.map((item) => ({
          cliKey: item.clientKey,
          reqDt: lguRequestDate(item.requestedAt),
        })),
      }),
    },
  )

  return parseResponse(response, eventAt)
}
