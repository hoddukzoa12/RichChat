import { changes, executeBatch } from './db/d1'
import { publish } from './db/events'
import type { LguFetch } from './lgu/protocol'
import {
  getLguAccessToken,
  type LguTokenEnv,
  type LguTokenProvider,
} from './lgu/token'

export const LGU_ATTACHMENT_RECOVERY_WINDOW_MS =
  7 * 24 * 60 * 60 * 1_000
export const ATTACHMENT_DOWNLOAD_LEASE_MS = 10 * 60 * 1_000

const MAX_ATTACHMENTS_PER_RUN = 100
const DEFINITIVE_MISSING_STATUSES = new Set([404, 410])

interface AttachmentDownloadEnv extends LguTokenEnv {
  ATTACHMENTS: R2Bucket
  LGU_CONTENT_HOST: string
}

interface ClaimedAttachment {
  id: string
  office_id: string
  message_id: string
  conversation_id: string
  mo_key: string
  original_filename: string | null
  mime_type: string | null
  created_at: number
  content_index: number
}

interface AmbiguousMessage {
  message_id: string
  attachment_count: number
}

interface AttachmentLogger {
  error(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
}

interface AttachmentDownloadOptions {
  fetch?: LguFetch
  logger?: AttachmentLogger
  now?: () => number
  tokenProvider?: LguTokenProvider
}

export interface AttachmentDownloadSummary {
  claimed: number
  completed: number
  failed: number
  deferred: number
  ambiguousMessages: number
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

export type ScheduledTask = (env: Env) => Promise<unknown>

const SCHEDULED_TASKS: readonly ScheduledTask[] = [
  runAttachmentDownloads,
]

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
  const expiresBefore = now - LGU_ATTACHMENT_RECOVERY_WINDOW_MS
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
           AND (
             candidate.created_at <= ?
             OR (
               SELECT COUNT(*)
               FROM message_attachments AS sibling
               WHERE sibling.message_id = candidate.message_id
             ) = 1
           )
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
         (
           SELECT mo_key
           FROM messages
           WHERE messages.id = message_attachments.message_id
         ) AS mo_key,
         original_filename,
         mime_type,
         created_at,
         content_index`,
    )
    .bind(leaseUntil, now, expiresBefore, now)
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

async function findAmbiguousMessages(
  db: D1Database,
  now: number,
): Promise<AmbiguousMessage[]> {
  const expiresBefore = now - LGU_ATTACHMENT_RECOVERY_WINDOW_MS
  const result = await db
    .prepare(
      `SELECT
         pending.message_id,
         (
           SELECT COUNT(*)
           FROM message_attachments AS sibling
           WHERE sibling.message_id = pending.message_id
         ) AS attachment_count
       FROM message_attachments AS pending
       WHERE pending.download_status = '대기'
         AND pending.created_at > ?
       GROUP BY pending.message_id
       HAVING attachment_count > 1
       ORDER BY pending.message_id`,
    )
    .bind(expiresBefore)
    .all<AmbiguousMessage>()

  return result.results
}

async function finalizeFailure(
  env: AttachmentDownloadEnv,
  attachment: ClaimedAttachment,
  leaseUntil: number,
  reason: 'expired' | 'missing',
  now: number,
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
  const statements = [
    ...publish(
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
    ),
    update,
  ]
  const results = await executeBatch(env.DB, statements)

  return changes(results[results.length - 1]) === 1
}

async function finalizeSuccess(
  env: AttachmentDownloadEnv,
  attachment: ClaimedAttachment,
  leaseUntil: number,
  object: R2Object,
  contentType: string,
  now: number,
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
  const statements = [
    ...publish(
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
    ),
    update,
  ]
  const results = await executeBatch(env.DB, statements)

  return changes(results[results.length - 1]) === 1
}

function requiredContentHost(env: AttachmentDownloadEnv): string {
  const host = env.LGU_CONTENT_HOST
  if (typeof host !== 'string' || host.trim() === '') {
    throw new Error('LGU_CONTENT_HOST가 설정되지 않았습니다.')
  }

  return host
}

async function processAttachment(
  env: AttachmentDownloadEnv,
  claim: {
    attachment: ClaimedAttachment
    leaseUntil: number
  },
  options: Required<
    Pick<AttachmentDownloadOptions, 'fetch' | 'logger' | 'now' | 'tokenProvider'>
  >,
): Promise<AttachmentOutcome> {
  const { attachment, leaseUntil } = claim
  const currentTime = options.now()
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
    )
    return failed ? 'failed' : 'deferred'
  }

  const r2Key = attachmentObjectKey(attachment.id)

  try {
    const existing = await env.ATTACHMENTS.head(r2Key)
    if (existing !== null) {
      const completed = await finalizeSuccess(
        env,
        attachment,
        leaseUntil,
        existing,
        attachment.mime_type ?? 'application/octet-stream',
        options.now(),
      )
      return completed ? 'completed' : 'deferred'
    }

    const token = await options.tokenProvider(env, attachment.office_id)
    const url = new URL(
      `/mo/v1/file/${encodeURIComponent(attachment.mo_key)}`,
      `https://${requiredContentHost(env)}`,
    )
    const response = await options.fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
      },
    })

    if (!response.ok) {
      await response.body?.cancel()
      if (DEFINITIVE_MISSING_STATUSES.has(response.status)) {
        const failed = await finalizeFailure(
          env,
          attachment,
          leaseUntil,
          'missing',
          options.now(),
        )
        return failed ? 'failed' : 'deferred'
      }

      options.logger.warn('첨부 다운로드를 나중에 재시도합니다.', {
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
      options.logger.warn('첨부 다운로드 응답에 바이너리가 없습니다.', {
        attachmentId: attachment.id,
      })
      return 'deferred'
    }

    const object = await env.ATTACHMENTS.put(r2Key, response.body, {
      httpMetadata: { contentType },
    })
    const completed = await finalizeSuccess(
      env,
      attachment,
      leaseUntil,
      object,
      contentType,
      options.now(),
    )
    return completed ? 'completed' : 'deferred'
  } catch (cause) {
    options.logger.warn('첨부 다운로드를 나중에 재시도합니다.', {
      attachmentId: attachment.id,
      errorName: cause instanceof Error ? cause.name : 'UnknownError',
      errorMessage:
        cause instanceof Error ? cause.message : '알 수 없는 오류',
    })
    return 'deferred'
  }
}

export async function runAttachmentDownloads(
  env: AttachmentDownloadEnv,
  options: AttachmentDownloadOptions = {},
): Promise<AttachmentDownloadSummary> {
  const resolvedOptions = {
    fetch: options.fetch ?? fetch,
    logger: options.logger ?? console,
    now: options.now ?? Date.now,
    tokenProvider: options.tokenProvider ?? getLguAccessToken,
  }
  const currentTime = resolvedOptions.now()
  const ambiguousMessages = await findAmbiguousMessages(
    env.DB,
    currentTime,
  )
  for (const message of ambiguousMessages) {
    resolvedOptions.logger.warn(
      '복수 첨부 MO는 재조회 응답과의 매핑을 확정할 수 없어 건너뜁니다.',
      {
        messageId: message.message_id,
        attachmentCount: message.attachment_count,
      },
    )
  }

  const summary: AttachmentDownloadSummary = {
    claimed: 0,
    completed: 0,
    failed: 0,
    deferred: 0,
    ambiguousMessages: ambiguousMessages.length,
  }

  for (
    let processed = 0;
    processed < MAX_ATTACHMENTS_PER_RUN;
    processed += 1
  ) {
    const claim = await claimNextAttachment(
      env.DB,
      resolvedOptions.now(),
    )
    if (claim === null) {
      break
    }

    summary.claimed += 1
    const outcome = await processAttachment(
      env,
      claim,
      resolvedOptions,
    )
    summary[OUTCOME_COUNTER[outcome]] += 1
  }

  return summary
}

export async function runScheduledTasks(
  env: Env,
  tasks: readonly ScheduledTask[] = SCHEDULED_TASKS,
): Promise<void> {
  await Promise.all(
    tasks.map(async (task) => {
      try {
        await task(env)
      } catch (cause) {
        console.error('스케줄 작업 실행에 실패했습니다.', cause)
      }
    }),
  )
}
