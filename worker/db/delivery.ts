import type { DeliveryStatus } from '../../shared/domain'
import { changes, executeBatch } from './d1'
import { publish } from './events'

export type ReportDeliveryStatus =
  | '접수'
  | '전송중'
  | '완료'
  | '실패'

export interface DeliveryReport {
  clientKey: string | null
  deliveredAt: number | null
  errorText: string | null
  eventAt: number
  msgKey: string | null
  resultCode: string | null
  status: ReportDeliveryStatus
}

export interface DeliveryReportSummary {
  changed: number
  unchanged: number
  unknown: string[]
}

interface MessageIdentity {
  conversation_id: string
  id: string
  office_id: string
}

const PREVIOUS_DELIVERY_STATUSES: Record<
  ReportDeliveryStatus,
  readonly DeliveryStatus[]
> = {
  접수: ['대기'],
  전송중: ['대기', '접수'],
  완료: ['대기', '접수', '전송중'],
  실패: ['대기', '접수', '전송중'],
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

async function findMessage(
  db: D1Database,
  report: DeliveryReport,
): Promise<MessageIdentity | null> {
  if (report.msgKey !== null) {
    const byMsgKey = await db
      .prepare(
        `SELECT id, office_id, conversation_id
         FROM messages
         WHERE msg_key = ?`,
      )
      .bind(report.msgKey)
      .first<MessageIdentity>()
    if (byMsgKey !== null) return byMsgKey
  }

  if (report.clientKey === null) return null

  return await db
    .prepare(
      `SELECT id, office_id, conversation_id
       FROM messages
       WHERE client_key = ? AND msg_key IS NULL`,
    )
    .bind(report.clientKey)
    .first<MessageIdentity>()
}

function reportIdentityGuard(report: DeliveryReport): {
  bindings: readonly unknown[]
  query: string
} {
  if (report.msgKey === null) {
    return {
      query: 'msg_key IS NULL AND client_key = ?',
      bindings: [report.clientKey],
    }
  }

  return report.clientKey === null
    ? {
        query: 'msg_key = ?',
        bindings: [report.msgKey],
      }
    : {
        query:
          '(msg_key = ? OR (msg_key IS NULL AND client_key = ?))',
        bindings: [report.msgKey, report.clientKey],
      }
}

async function applyDeliveryReport(
  db: D1Database,
  report: DeliveryReport,
): Promise<'changed' | 'unchanged' | 'unknown'> {
  const message = await findMessage(db, report)
  if (message === null) return 'unknown'

  const previousStatuses = PREVIOUS_DELIVERY_STATUSES[report.status]
  const identityGuard = reportIdentityGuard(report)
  const transitionGuard = {
    query: `SELECT 1
            FROM messages
            WHERE id = ?
              AND ${identityGuard.query}
              AND delivery_status IN (${placeholders(previousStatuses)})`,
    bindings: [
      message.id,
      ...identityGuard.bindings,
      ...previousStatuses,
    ],
  }
  const mutation = db
    .prepare(
      `UPDATE messages
       SET
         msg_key = COALESCE(msg_key, ?),
         delivery_status = ?,
         result_code = COALESCE(?, result_code),
         delivered_at = ?,
         error_text = ?
       WHERE id = ?
         AND ${identityGuard.query}
         AND delivery_status IN (${placeholders(previousStatuses)})`,
    )
    .bind(
      report.msgKey,
      report.status,
      report.resultCode,
      report.deliveredAt,
      report.errorText,
      message.id,
      ...identityGuard.bindings,
      ...previousStatuses,
    )
  const results = await executeBatch(db, [
    ...publish(
      db,
      {
        officeId: message.office_id,
        type: 'message.delivery_updated',
        entity: 'message',
        entityId: message.id,
        conversationId: message.conversation_id,
        actorKind: 'system',
        payload: {
          deliveryStatus: report.status,
          resultCode: report.resultCode,
        },
        createdAt: report.eventAt,
      },
      transitionGuard,
    ),
    mutation,
  ])

  return changes(results[results.length - 1]) === 1
    ? 'changed'
    : 'unchanged'
}

export async function applyDeliveryReports(
  db: D1Database,
  reports: readonly DeliveryReport[],
): Promise<DeliveryReportSummary> {
  const summary: DeliveryReportSummary = {
    changed: 0,
    unchanged: 0,
    unknown: [],
  }

  for (const report of reports) {
    const outcome = await applyDeliveryReport(db, report)
    if (outcome === 'unknown') {
      summary.unknown.push(report.msgKey ?? report.clientKey ?? '(키 없음)')
      continue
    }
    summary[outcome] += 1
  }

  return summary
}
