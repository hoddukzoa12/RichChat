import { changes } from './db/d1'
import { applyDeliveryReports } from './db/delivery'
import { publish } from './db/events'
import type { LguFetch } from './lgu/protocol'
import {
  queryLguDeliveryReports,
  type PendingReportQuery,
} from './lgu/report'
import type { LguTokenProvider } from './lgu/token'
import { executeBatchAndBroadcast } from './realtime/broadcast'

export const LGU_ATTACHMENT_RECOVERY_WINDOW_MS =
  24 * 60 * 60 * 1_000
export const ATTACHMENT_DOWNLOAD_LEASE_MS = 10 * 60 * 1_000
export const REPORT_RECONCILIATION_AGE_MS = 2 * 60 * 1_000

const MAX_ATTACHMENTS_PER_RUN = 100
const DEFINITIVE_MISSING_STATUSES = new Set([404, 410])
const MAX_REPORTS_PER_REQUEST = 10
const CLOUDFRONT_HOST_PATTERN = /^[a-z0-9]+\.cloudfront\.net$/u

interface AttachmentDownloadEnv {
  DB: D1Database
  ATTACHMENTS: R2Bucket
  OFFICE_HUB: Env['OFFICE_HUB']
}

interface ClaimedAttachment {
  id: string
  office_id: string
  message_id: string
  conversation_id: string
  original_filename: string | null
  byte_size: number | null
  mime_type: string | null
  created_at: number
  content_index: number
  content_url: string
}

interface PendingReportRow {
  client_key: string
  created_at: number
  office_id: string
}

interface AttachmentLogger {
  error(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
}

interface DeliveryReportOptions {
  fetch?: LguFetch
  logger?: AttachmentLogger
  now?: () => number
  tokenProvider?: LguTokenProvider
}

interface AttachmentDownloadOptions {
  fetch?: LguFetch
  logger?: AttachmentLogger
  now?: () => number
}

export interface AttachmentDownloadSummary {
  claimed: number
  completed: number
  failed: number
  deferred: number
}

export interface DeliveryReportReconciliationSummary {
  changed: number
  queried: number
  rejected: number
  unchanged: number
  unknown: number
}

type AttachmentOutcome = 'completed' | 'failed' | 'deferred'

const OUTCOME_COUNTER: Record<
  AttachmentOutcome,
  'completed' | 'failed' | 'deferred'
> = {
  completed: 'completed',
  failed: 'failed',
  deferred: 'deferred',
}

export type ScheduledTask = (
  env: Env,
  ctx?: ExecutionContext,
) => Promise<unknown>

const SCHEDULED_TASKS: readonly ScheduledTask[] = [
  (env, ctx) => runDeliveryReportReconciliation(env, {}, ctx),
  (env, ctx) => runAttachmentDownloads(env, {}, ctx),
]

export const PENDING_DELIVERY_REPORT_QUERY =
  `SELECT office_id, client_key, created_at
   FROM messages INDEXED BY ix_messages_pending
   WHERE delivery_status IN ('대기', '접수', '전송중')
     AND created_at <= ?
     AND client_key IS NOT NULL
   ORDER BY delivery_status, created_at, id
   LIMIT ?`

function attachmentObjectKey(attachmentId: string): string {
  return `attachments/${attachmentId}`
}

async function claimNextAttachment(
  db: D1Database,
  now: number,
): Promise<{
  attachment: ClaimedAttachment
  leaseUntil: number
} | null> {
  const leaseUntil = now + ATTACHMENT_DOWNLOAD_LEASE_MS
  const result = await db
    .prepare(
      `UPDATE message_attachments
       SET download_lease_until = ?
       WHERE id = (
         SELECT candidate.id
         FROM message_attachments AS candidate
         JOIN messages ON messages.id = candidate.message_id
         WHERE candidate.download_status = '대기'
           AND candidate.download_lease_until <= ?
           AND messages.mo_key IS NOT NULL
           AND candidate.content_url IS NOT NULL
         ORDER BY candidate.created_at, candidate.id
         LIMIT 1
       )
         AND download_status = '대기'
         AND download_lease_until <= ?
       RETURNING
         id,
         office_id,
         message_id,
         (
           SELECT conversation_id
           FROM messages
           WHERE messages.id = message_attachments.message_id
         ) AS conversation_id,
         original_filename,
         byte_size,
         mime_type,
         created_at,
         content_index,
         content_url`,
    )
    .bind(leaseUntil, now, now)
    .run<ClaimedAttachment>()

  if (changes(result) !== 1) {
    return null
  }

  const attachment = result.results[0]
  if (attachment === undefined) {
    throw new Error('선점한 첨부 행을 반환받지 못했습니다.')
  }

  return { attachment, leaseUntil }
}

async function finalizeFailure(
  env: AttachmentDownloadEnv,
  attachment: ClaimedAttachment,
  leaseUntil: number,
  reason: 'expired' | 'invalid_url' | 'missing',
  now: number,
  ctx?: ExecutionContext,
): Promise<boolean> {
  const guard = {
    query: `SELECT 1
            FROM message_attachments
            WHERE id = ?
              AND download_status = '대기'
              AND download_lease_until = ?`,
    bindings: [attachment.id, leaseUntil],
  }
  const update = env.DB
    .prepare(
      `UPDATE message_attachments
       SET download_status = '실패', download_lease_until = 0
       WHERE id = ?
         AND download_status = '대기'
         AND download_lease_until = ?`,
    )
    .bind(attachment.id, leaseUntil)
  const publication = publish(
    env.DB,
    {
      officeId: attachment.office_id,
      type: 'attachment.download_failed',
      entity: 'attachment',
      entityId: attachment.id,
      conversationId: attachment.conversation_id,
      actorKind: 'system',
      payload: { status: '실패', reason },
      createdAt: now,
    },
    guard,
  )
  const statements = [
    ...publication,
    update,
  ]
  const results = await executeBatchAndBroadcast(
    env.DB,
    statements,
    [publication],
    ctx,
    env,
  )

  return changes(results[results.length - 1]) === 1
}

async function finalizeSuccess(
  env: AttachmentDownloadEnv,
  attachment: ClaimedAttachment,
  leaseUntil: number,
  object: R2Object,
  contentType: string,
  now: number,
  ctx?: ExecutionContext,
): Promise<boolean> {
  const r2Key = attachmentObjectKey(attachment.id)
  const guard = {
    query: `SELECT 1
            FROM message_attachments
            WHERE id = ?
              AND download_status = '대기'
              AND download_lease_until = ?`,
    bindings: [attachment.id, leaseUntil],
  }
  const update = env.DB
    .prepare(
      `UPDATE message_attachments
       SET
         original_filename = COALESCE(original_filename, ?),
         byte_size = COALESCE(byte_size, ?),
         mime_type = COALESCE(mime_type, ?),
         r2_key = ?,
         download_status = '완료',
         download_lease_until = 0
       WHERE id = ?
         AND download_status = '대기'
         AND download_lease_until = ?`,
    )
    .bind(
      attachment.id,
      object.size,
      contentType,
      r2Key,
      attachment.id,
      leaseUntil,
    )
  const publication = publish(
    env.DB,
    {
      officeId: attachment.office_id,
      type: 'attachment.downloaded',
      entity: 'attachment',
      entityId: attachment.id,
      conversationId: attachment.conversation_id,
      actorKind: 'system',
      payload: { status: '완료' },
      createdAt: now,
    },
    guard,
  )
  const statements = [
    ...publication,
    update,
  ]
  const results = await executeBatchAndBroadcast(
    env.DB,
    statements,
    [publication],
    ctx,
    env,
  )

  return changes(results[results.length - 1]) === 1
}

function validatedContentUrl(value: string): URL | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !CLOUDFRONT_HOST_PATTERN.test(url.hostname)
  ) {
    return null
  }

  return url
}

async function processAttachment(
  env: AttachmentDownloadEnv,
  claim: {
    attachment: ClaimedAttachment
    leaseUntil: number
  },
  fetcher: LguFetch,
  logger: AttachmentLogger,
  now: () => number,
  ctx?: ExecutionContext,
): Promise<AttachmentOutcome> {
  const { attachment, leaseUntil } = claim
  const currentTime = now()
  if (
    attachment.created_at <=
    currentTime - LGU_ATTACHMENT_RECOVERY_WINDOW_MS
  ) {
    const failed = await finalizeFailure(
      env,
      attachment,
      leaseUntil,
      'expired',
      currentTime,
      ctx,
    )
    return failed ? 'failed' : 'deferred'
  }

  const r2Key = attachmentObjectKey(attachment.id)

  try {
    const existing = await env.ATTACHMENTS.head(r2Key)
    if (existing !== null) {
      if (
        attachment.byte_size !== null &&
        existing.size !== attachment.byte_size
      ) {
        await env.ATTACHMENTS.delete(r2Key)
      } else {
        const completed = await finalizeSuccess(
          env,
          attachment,
          leaseUntil,
          existing,
          attachment.mime_type ?? 'application/octet-stream',
          now(),
          ctx,
        )
        return completed ? 'completed' : 'deferred'
      }
    }

    const url = validatedContentUrl(attachment.content_url)
    if (url === null) {
      logger.warn('허용하지 않는 첨부 URL을 거부합니다.', {
        attachmentId: attachment.id,
      })
      const failed = await finalizeFailure(
        env,
        attachment,
        leaseUntil,
        'invalid_url',
        now(),
        ctx,
      )
      return failed ? 'failed' : 'deferred'
    }

    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
    })

    if (!response.ok) {
      await response.body?.cancel()
      if (DEFINITIVE_MISSING_STATUSES.has(response.status)) {
        const failed = await finalizeFailure(
          env,
          attachment,
          leaseUntil,
          'missing',
          now(),
          ctx,
        )
        return failed ? 'failed' : 'deferred'
      }

      logger.warn('첨부 다운로드를 나중에 재시도합니다.', {
        attachmentId: attachment.id,
        status: response.status,
      })
      return 'deferred'
    }

    const contentType =
      response.headers.get('content-type') ??
      attachment.mime_type ??
      'application/octet-stream'
    if (response.body === null) {
      logger.warn('첨부 다운로드 응답에 바이너리가 없습니다.', {
        attachmentId: attachment.id,
      })
      return 'deferred'
    }

    const object = await env.ATTACHMENTS.put(r2Key, response.body, {
      httpMetadata: { contentType },
    })
    if (
      attachment.byte_size !== null &&
      object.size !== attachment.byte_size
    ) {
      await env.ATTACHMENTS.delete(r2Key)
      logger.warn('첨부 크기가 웹훅 메타데이터와 일치하지 않습니다.', {
        attachmentId: attachment.id,
        actualSize: object.size,
        expectedSize: attachment.byte_size,
      })
      return 'deferred'
    }
    const completed = await finalizeSuccess(
      env,
      attachment,
      leaseUntil,
      object,
      contentType,
      now(),
      ctx,
    )
    return completed ? 'completed' : 'deferred'
  } catch (cause) {
    logger.warn('첨부 다운로드를 나중에 재시도합니다.', {
      attachmentId: attachment.id,
      errorName: cause instanceof Error ? cause.name : 'UnknownError',
      errorMessage:
        cause instanceof Error ? cause.message : '알 수 없는 오류',
    })
    return 'deferred'
  }
}

function fetchAttachment(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // workerd의 전역 fetch는 this 검사를 한다. 객체 속성에 직접 담아
  // options.fetch(...)로 호출하면 Illegal invocation이므로 맨 호출로 감싼다.
  return fetch(input, init)
}

export async function runAttachmentDownloads(
  env: AttachmentDownloadEnv,
  options: AttachmentDownloadOptions = {},
  ctx?: ExecutionContext,
): Promise<AttachmentDownloadSummary> {
  const fetcher = options.fetch ?? fetchAttachment
  const logger = options.logger ?? console
  const now = options.now ?? (() => Date.now())

  const summary: AttachmentDownloadSummary = {
    claimed: 0,
    completed: 0,
    failed: 0,
    deferred: 0,
  }

  for (
    let processed = 0;
    processed < MAX_ATTACHMENTS_PER_RUN;
    processed += 1
  ) {
    const claim = await claimNextAttachment(
      env.DB,
      now(),
    )
    if (claim === null) {
      break
    }

    summary.claimed += 1
    const outcome = await processAttachment(
      env,
      claim,
      fetcher,
      logger,
      now,
      ctx,
    )
    summary[OUTCOME_COUNTER[outcome]] += 1
  }

  return summary
}

export async function runDeliveryReportReconciliation(
  env: Env,
  options: DeliveryReportOptions = {},
  ctx?: ExecutionContext,
): Promise<DeliveryReportReconciliationSummary> {
  const now = options.now ?? Date.now
  const currentTime = now()
  const logger = options.logger ?? console
  const pending = await env.DB
    .prepare(PENDING_DELIVERY_REPORT_QUERY)
    .bind(
      currentTime - REPORT_RECONCILIATION_AGE_MS,
      MAX_REPORTS_PER_REQUEST,
    )
    .all<PendingReportRow>()
  const summary: DeliveryReportReconciliationSummary = {
    changed: 0,
    queried: pending.results.length,
    rejected: 0,
    unchanged: 0,
    unknown: 0,
  }
  if (pending.results.length === 0) return summary

  const byOffice = new Map<string, PendingReportQuery[]>()
  for (const row of pending.results) {
    const officePending = byOffice.get(row.office_id) ?? []
    officePending.push({
      clientKey: row.client_key,
      requestedAt: row.created_at,
    })
    byOffice.set(row.office_id, officePending)
  }

  for (const [officeId, officePending] of byOffice) {
    const result = await queryLguDeliveryReports(
      env,
      officeId,
      officePending,
      {
        fetch: options.fetch,
        now: () => currentTime,
        tokenProvider: options.tokenProvider,
      },
    )
    for (const item of result.rejected) {
      logger.warn('결정적으로 잘못된 LGU+ 조회 리포트를 격리합니다.', {
        msgKey: item.msgKey,
        receivedStatus: item.status,
        reason: item.reason,
      })
    }

    const applied = await applyDeliveryReports(env.DB, result.reports, {
      ctx,
      env,
    })
    summary.changed += applied.changed
    summary.rejected += result.rejected.length
    summary.unchanged += applied.unchanged
    summary.unknown += applied.unknown.length
    if (applied.unknown.length > 0) {
      logger.warn('LGU+ 조회 리포트를 메시지와 결합하지 못했습니다.', {
        reportKeys: applied.unknown,
      })
    }
  }

  return summary
}

export async function runScheduledTasks(
  env: Env,
  tasks: readonly ScheduledTask[] = SCHEDULED_TASKS,
  ctx?: ExecutionContext,
): Promise<void> {
  await Promise.all(
    tasks.map(async (task) => {
      try {
        await task(env, ctx)
      } catch (cause) {
        console.error('스케줄 작업 실행에 실패했습니다.', cause)
      }
    }),
  )
}
