import type { SendChannel } from '../../shared/domain'
import { OUTBOUND_IMAGE_LIMITS } from '../../shared/attachments'
import {
  containsEmoji,
  pickMessageType,
} from '../../shared/sms'
import type {
  ConversationMessage,
  MessageAttachment,
} from '../../shared/wire/message'
import type {
  SendMessageAttachment,
  SendMessageResponse,
} from '../../shared/wire/message-send'
import { loadMessageAttachments } from '../attachments'
import { changes } from '../db/d1'
import {
  publish,
  type EventPublication,
} from '../db/events'
import { error } from '../http/error'
import { json } from '../http/respond'
import type { Route } from '../http/router'
import {
  requireSession,
  type SessionContext,
} from '../http/session'
import { LguApiError } from '../lgu/http'
import {
  LGU_SEND_TIMEOUT_MS,
  sendTextMessage,
  type ConfirmedSendResult,
  type LguRequest,
  type OutboundChannel,
} from '../lgu/send'
import { uploadMmsFile } from '../lgu/upload'
import { createId, type Clock } from '../lib/ids'
import { executeBatchAndBroadcast } from '../realtime/broadcast'

type JsonObject = Record<string, unknown>
interface ParsedSendMessage {
  attachments: SendMessageAttachment[]
  body: string
  channel: OutboundChannel
  clientKey: string
}

interface SendContext {
  callback: string | null
  phone_e164: string
}

interface MessageRow {
  id: string
  channel: SendChannel
  body: string
  sender_user_id: string
  sender_name: string
  sender_title: string
  occurred_at: number
  delivery_status: '대기' | '접수' | '전송중' | '완료' | '실패'
  result_code: string | null
  delivered_at: number | null
  error_text: string | null
}

interface MessageSendDependencies {
  clock?: Clock
  idFactory?: () => string
  lguRequest?: LguRequest
  timeoutMs?: number
}

interface MessageCreationPlan {
  publication: EventPublication
  statements: D1PreparedStatement[]
}

interface StagedAttachment {
  id: string
  original_filename: string
  byte_size: number
  mime_type: string
  r2_key: string
  created_at: number
}

interface PreparedAttachment extends StagedAttachment {
  bytes: ArrayBuffer
}

const MESSAGE_PATH = '/api/conversations/:id/messages'
const MESSAGE_ENTITY = 'message'
const MESSAGE_EVENT = {
  created: 'message.created',
  deliveryUpdated: 'message.delivery_updated',
} as const
function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

async function readRequest(
  request: Request,
): Promise<ParsedSendMessage | Response> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    return error('BAD_REQUEST', '올바른 JSON 본문이 필요합니다.')
  }

  if (!isJsonObject(value)) {
    return error('BAD_REQUEST', 'JSON 객체가 필요합니다.')
  }

  const rawAttachments = value.attachments
  if (
    rawAttachments !== undefined &&
    !Array.isArray(rawAttachments)
  ) {
    return error('BAD_REQUEST', '첨부 입력값을 확인해 주세요.')
  }
  const attachmentValues = rawAttachments ?? []
  if (attachmentValues.length > OUTBOUND_IMAGE_LIMITS.count) {
    return error(
      'BAD_REQUEST',
      `첨부 이미지는 최대 ${OUTBOUND_IMAGE_LIMITS.count}장까지 보낼 수 있습니다.`,
    )
  }

  const attachments: SendMessageAttachment[] = []
  const attachmentIds = new Set<string>()
  for (const attachment of attachmentValues) {
    if (
      !isJsonObject(attachment) ||
      typeof attachment.id !== 'string' ||
      attachment.id.trim() === '' ||
      attachmentIds.has(attachment.id)
    ) {
      return error('BAD_REQUEST', '첨부 입력값을 확인해 주세요.')
    }
    attachmentIds.add(attachment.id)
    attachments.push({ id: attachment.id })
  }

  if (
    !hasOwn(value, 'clientKey') ||
    typeof value.clientKey !== 'string' ||
    value.clientKey.trim() === '' ||
    value.clientKey.length > 128 ||
    !hasOwn(value, 'body') ||
    typeof value.body !== 'string' ||
    (value.body.trim() === '' && attachments.length === 0)
  ) {
    return error('BAD_REQUEST', '메시지 입력값을 확인해 주세요.')
  }

  if (containsEmoji(value.body)) {
    return error(
      'MSG_EMOJI_UNSUPPORTED',
      '문자 메시지로 보낼 수 없는 이모지가 포함되어 있습니다.',
    )
  }

  const textChannel = pickMessageType(value.body)
  if (textChannel === 'TOO_LONG') {
    return error(
      'MSG_TOO_LONG',
      '문자 메시지는 EUC-KR 기준 2,000바이트를 넘을 수 없습니다.',
    )
  }

  return {
    clientKey: value.clientKey,
    body: value.body,
    channel: attachments.length > 0 ? 'MMS' : textChannel,
    attachments,
  }
}

function koreanPhone(value: string): string | null {
  const match = /^\+82(\d{8,10})$/.exec(value)
  return match ? `0${match[1]}` : null
}

async function prepareAttachments(
  env: Env,
  conversationId: string,
  references: SendMessageAttachment[],
): Promise<PreparedAttachment[] | Response> {
  if (references.length === 0) return []

  const placeholders = references.map(() => '?').join(', ')
  const { results } = await env.DB
    .prepare(
      `SELECT
         id,
         original_filename,
         byte_size,
         mime_type,
         r2_key,
         created_at
       FROM outbound_attachment_uploads
       WHERE conversation_id = ?
         AND id IN (${placeholders})`,
    )
    .bind(conversationId, ...references.map(({ id }) => id))
    .all<StagedAttachment>()
  const byId = new Map(results.map((row) => [row.id, row]))

  if (byId.size !== references.length) {
    return error(
      'BAD_REQUEST',
      '보낼 수 있는 첨부 이미지를 찾지 못했습니다.',
    )
  }

  const prepared: PreparedAttachment[] = []
  for (const { id } of references) {
    const row = byId.get(id)
    if (!row) {
      return error(
        'BAD_REQUEST',
        '보낼 수 있는 첨부 이미지를 찾지 못했습니다.',
      )
    }
    const object = await env.ATTACHMENTS.get(row.r2_key)
    if (object === null || object.size !== row.byte_size) {
      return error(
        'CONFLICT',
        '저장된 첨부 이미지를 확인할 수 없습니다.',
      )
    }
    prepared.push({
      ...row,
      bytes: await object.arrayBuffer(),
    })
  }

  return prepared
}

async function loadExistingMessage(
  db: D1Database,
  session: SessionContext,
  conversationId: string,
  clientKey: string,
): Promise<ConversationMessage | null> {
  const row = await db
    .prepare(
      `SELECT
         messages.id,
         messages.channel,
         messages.body,
         messages.sender_user_id,
         users.name AS sender_name,
         users.title AS sender_title,
         messages.occurred_at,
         messages.delivery_status,
         messages.result_code,
         messages.delivered_at,
         messages.error_text
       FROM messages
       INNER JOIN users
         ON users.id = messages.sender_user_id
         AND users.office_id = messages.office_id
       WHERE messages.client_key = ?
         AND messages.office_id = ?
         AND messages.conversation_id = ?`,
    )
    .bind(clientKey, session.officeId, conversationId)
    .first<MessageRow>()

  if (!row) return null
  const attachments = await loadMessageAttachments(
    db,
    session.officeId,
    [row.id],
  )
  return messageFromRow(row, attachments.get(row.id) ?? [])
}

function messageFromRow(
  row: MessageRow,
  attachments: MessageAttachment[],
): ConversationMessage {
  return {
    id: row.id,
    direction: 'out',
    channel: row.channel,
    title: null,
    body: row.body,
    sender: {
      id: row.sender_user_id,
      name: row.sender_name,
      title: row.sender_title,
    },
    occurredAt: row.occurred_at,
    deliveryStatus: row.delivery_status,
    resultCode: row.result_code,
    deliveredAt: row.delivered_at,
    errorText: row.error_text,
    attachments,
  }
}

async function loadSendContext(
  db: D1Database,
  session: SessionContext,
  conversationId: string,
): Promise<SendContext | null> {
  return await db
    .prepare(
      `SELECT
         customers.phone_e164,
         (
           SELECT value
           FROM office_channels
           WHERE office_id = ?
             AND is_default = 1
             AND active = 1
         ) AS callback
       FROM conversations
       INNER JOIN customers
         ON customers.id = conversations.customer_id
         AND customers.office_id = conversations.office_id
       WHERE conversations.id = ?
         AND conversations.office_id = ?`,
    )
    .bind(session.officeId, conversationId, session.officeId)
    .first<SendContext>()
}

function createStatements(
  db: D1Database,
  values: {
    attachments: PreparedAttachment[]
    body: string
    channel: OutboundChannel
    clientKey: string
    conversationId: string
    messageId: string
    now: number
    session: SessionContext
  },
): MessageCreationPlan {
  const {
    attachments,
    body,
    channel,
    clientKey,
    conversationId,
    messageId,
    now,
    session,
  } = values
  const createdGuard = {
    query: `SELECT 1
            FROM messages
            WHERE id = ?
              AND client_key = ?`,
    bindings: [messageId, clientKey],
  }
  const publication = publish(
    db,
    {
      officeId: session.officeId,
      type: MESSAGE_EVENT.created,
      entity: MESSAGE_ENTITY,
      entityId: messageId,
      conversationId,
      actorKind: 'user',
      actorId: session.userId,
      payload: {
        direction: 'out',
        channel,
        deliveryStatus: '대기',
      },
      createdAt: now,
    },
    createdGuard,
  )
  const attachmentStatements = attachments.flatMap(
    (attachment, contentIndex) => [
      db
        .prepare(
          `INSERT INTO message_attachments (
             id, office_id, message_id, original_filename, byte_size,
             mime_type, r2_key, download_status, created_at, content_index
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, '완료', ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM messages
             WHERE id = ?
               AND client_key = ?
           )`,
        )
        .bind(
          attachment.id,
          session.officeId,
          messageId,
          attachment.original_filename,
          attachment.byte_size,
          attachment.mime_type,
          attachment.r2_key,
          attachment.created_at,
          contentIndex,
          messageId,
          clientKey,
        ),
      db
        .prepare(
          `DELETE FROM outbound_attachment_uploads
           WHERE id = ?
             AND EXISTS (
               SELECT 1
               FROM messages
               WHERE id = ?
                 AND client_key = ?
             )`,
        )
        .bind(attachment.id, messageId, clientKey),
    ],
  )

  return {
    publication,
    statements: [
      db
        .prepare(
          `INSERT INTO messages (
             id, office_id, conversation_id, direction, channel, title, body,
             sender_user_id, occurred_at, created_at, mo_key, client_key,
             msg_key, delivery_status
           )
           SELECT
             ?, ?, id, 'out', ?, NULL, ?, ?, ?, ?, NULL, ?, NULL, '대기'
           FROM conversations
           WHERE id = ?
             AND office_id = ?
           ON CONFLICT(client_key) WHERE client_key IS NOT NULL DO NOTHING`,
        )
        .bind(
          messageId,
          session.officeId,
          channel,
          body,
          session.userId,
          now,
          now,
          clientKey,
          conversationId,
          session.officeId,
        ),
      ...attachmentStatements,
      db
        .prepare(
          `UPDATE conversations
           SET
             status = '처리중',
             last_message_id = CASE
               WHEN last_message_at IS NULL OR ? >= last_message_at THEN ?
               ELSE last_message_id
             END,
             last_message_at = CASE
               WHEN last_message_at IS NULL OR ? >= last_message_at THEN ?
               ELSE last_message_at
             END,
             version = version + 1,
             updated_at = MAX(updated_at, ?)
           WHERE id = ?
             AND office_id = ?
             AND EXISTS (
               SELECT 1
               FROM messages
               WHERE id = ?
                 AND client_key = ?
             )`,
        )
        .bind(
          now,
          messageId,
          now,
          now,
          now,
          conversationId,
          session.officeId,
          messageId,
          clientKey,
        ),
      db
        .prepare(
          `INSERT INTO conversation_assignees (
             conversation_id, office_id, user_id, assigned_at, assigned_by
           )
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM messages
             WHERE id = ?
               AND client_key = ?
           )
             AND NOT EXISTS (
               SELECT 1
               FROM conversation_assignees
               WHERE conversation_id = ?
             )
           ON CONFLICT(conversation_id, user_id) DO NOTHING`,
        )
        .bind(
          conversationId,
          session.officeId,
          session.userId,
          now,
          session.userId,
          messageId,
          clientKey,
          conversationId,
        ),
      ...publication,
    ],
  }
}

async function recordDeliveryResult(
  env: Env,
  ctx: ExecutionContext | undefined,
  values: {
    conversationId: string
    messageId: string
    now: number
    result: ConfirmedSendResult
    session: SessionContext
  },
): Promise<void> {
  const { conversationId, messageId, now, result, session } = values
  const accepted = result.kind === 'accepted'
  const deliveryStatus = accepted ? '접수' : '실패'
  const msgKey = accepted ? result.msgKey : null
  const errorText = accepted ? null : result.errorText
  const guard = {
    query: `SELECT 1
            FROM messages
            WHERE id = ?
              AND office_id = ?
              AND delivery_status = '대기'`,
    bindings: [messageId, session.officeId],
  }
  const mutation = env.DB
    .prepare(
      `UPDATE messages
       SET
         delivery_status = ?,
         msg_key = ?,
         result_code = ?,
         error_text = ?
       WHERE id = ?
         AND office_id = ?
         AND delivery_status = '대기'`,
    )
    .bind(
      deliveryStatus,
      msgKey,
      result.code,
      errorText,
      messageId,
      session.officeId,
    )

  const publication = publish(
    env.DB,
    {
      officeId: session.officeId,
      type: MESSAGE_EVENT.deliveryUpdated,
      entity: MESSAGE_ENTITY,
      entityId: messageId,
      conversationId,
      actorKind: 'system',
      payload: {
        deliveryStatus,
        resultCode: result.code,
      },
      createdAt: now,
    },
    guard,
  )
  const statements = [
    ...publication,
    mutation,
  ]
  await executeBatchAndBroadcast(
    env.DB,
    statements,
    [publication],
    ctx,
    env,
  )
}

async function uploadAttachmentsToLgu(
  env: Env,
  officeId: string,
  attachments: PreparedAttachment[],
  lguRequest?: LguRequest,
): Promise<void> {
  for (const attachment of attachments) {
    await uploadMmsFile(
      env,
      {
        bytes: attachment.bytes,
        fileId: attachment.id,
        filename: attachment.original_filename,
        mimeType: attachment.mime_type,
        officeId,
      },
      lguRequest,
    )
  }
}

function attachmentUploadFailure(cause: unknown): ConfirmedSendResult {
  const code =
    cause instanceof LguApiError
      ? cause.code
      : 'ATTACHMENT_UPLOAD_FAILED'

  return {
    kind: 'rejected',
    code,
    errorText: `LGU+ 첨부 업로드에 실패했습니다. (${code})`,
  }
}

function messageResponse(
  clientKey: string,
  message: ConversationMessage,
  status = 200,
): Response {
  return json(
    { clientKey, message } satisfies SendMessageResponse,
    { status },
  )
}

export function createMessageSendRoutes(
  dependencies: MessageSendDependencies = {},
): Route[] {
  const clock = dependencies.clock ?? Date.now
  const idFactory = dependencies.idFactory ?? createId
  const lguRequest = dependencies.lguRequest
  const timeoutMs = dependencies.timeoutMs ?? LGU_SEND_TIMEOUT_MS

  async function sendMessage(
    request: Request,
    env: Env,
    params: Readonly<Record<string, string>>,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session

    const input = await readRequest(request)
    if (input instanceof Response) return input

    const existing = await loadExistingMessage(
      env.DB,
      session,
      params.id,
      input.clientKey,
    )
    if (existing) return messageResponse(input.clientKey, existing)

    const context = await loadSendContext(env.DB, session, params.id)
    if (!context) {
      return error('NOT_FOUND', '대화를 찾을 수 없습니다.')
    }
    if (!context.callback) {
      return error('CONFLICT', '기본 발신번호가 설정되어 있지 않습니다.')
    }

    const phone = koreanPhone(context.phone_e164)
    if (!phone) {
      return error('INTERNAL_ERROR', '수신번호를 확인할 수 없습니다.')
    }
    const attachments = await prepareAttachments(
      env,
      params.id,
      input.attachments,
    )
    if (attachments instanceof Response) {
      const duplicate = await loadExistingMessage(
        env.DB,
        session,
        params.id,
        input.clientKey,
      )
      return duplicate
        ? messageResponse(input.clientKey, duplicate)
        : attachments
    }

    const messageId = idFactory()
    const now = clock()
    let creationResults: D1Result[]
    try {
      const plan = createStatements(env.DB, {
        attachments,
        body: input.body,
        channel: input.channel,
        clientKey: input.clientKey,
        conversationId: params.id,
        messageId,
        now,
        session,
      })
      creationResults = await executeBatchAndBroadcast(
        env.DB,
        plan.statements,
        [plan.publication],
        ctx,
        env,
      )
    } catch {
      return error('INTERNAL_ERROR', '메시지를 저장하지 못했습니다.')
    }

    if (changes(creationResults[0]) === 0) {
      const duplicate = await loadExistingMessage(
        env.DB,
        session,
        params.id,
        input.clientKey,
      )
      return duplicate
        ? messageResponse(input.clientKey, duplicate)
        : error('CONFLICT', '메시지 요청을 처리할 수 없습니다.')
    }

    if (attachments.length > 0) {
      try {
        await uploadAttachmentsToLgu(
          env,
          session.officeId,
          attachments,
          lguRequest,
        )
      } catch (cause) {
        try {
          await recordDeliveryResult(env, ctx, {
            conversationId: params.id,
            messageId,
            now: clock(),
            result: attachmentUploadFailure(cause),
            session,
          })
        } catch {
          return error(
            'INTERNAL_ERROR',
            '첨부 업로드 실패 결과를 저장하지 못했습니다.',
          )
        }

        const failedMessage = await loadExistingMessage(
          env.DB,
          session,
          params.id,
          input.clientKey,
        )
        return failedMessage
          ? messageResponse(input.clientKey, failedMessage, 201)
          : error('INTERNAL_ERROR', '메시지를 불러오지 못했습니다.')
      }
    }

    const sendResult = await sendTextMessage(
      env,
      {
        body: input.body,
        callback: context.callback,
        channel: input.channel,
        fileIds: attachments.map(({ id }) => id),
        officeId: session.officeId,
        phone,
        providerKey: messageId,
        timeoutMs,
      },
      lguRequest,
    )

    if (sendResult.kind !== 'uncertain') {
      try {
        await recordDeliveryResult(env, ctx, {
          conversationId: params.id,
          messageId,
          now: clock(),
          result: sendResult,
          session,
        })
      } catch {
        return error(
          'INTERNAL_ERROR',
          '메시지 발송 결과를 저장하지 못했습니다.',
        )
      }
    }

    const message = await loadExistingMessage(
      env.DB,
      session,
      params.id,
      input.clientKey,
    )
    return message
      ? messageResponse(input.clientKey, message, 201)
      : error('INTERNAL_ERROR', '메시지를 불러오지 못했습니다.')
  }

  return [
    {
      method: 'POST',
      path: MESSAGE_PATH,
      handler: sendMessage,
    },
  ]
}

export const routes = createMessageSendRoutes()
