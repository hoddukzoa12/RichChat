import type { JsonValue, SendChannel } from '../shared/domain'
import { changes } from './db/d1'
import { publish } from './db/events'
import { createId } from './lib/ids'
import { executeBatchAndBroadcast } from './realtime/broadcast'

export interface InboundAttachment {
  originalFilename: string | null
  byteSize: number | null
  mimeType: string | null
  contentUrl: string | null
  contentIndex?: number
}

export interface InboundMessageInput {
  officeId: string
  officeChannelId: string | null
  customerPhoneE164: string
  channel: SendChannel
  title: string | null
  body: string
  occurredAt: number
  receivedAt: number
  idempotencyKey: string
  attachments?: readonly InboundAttachment[]
  mergeExistingBody?: boolean
  mergeExistingOccurredAt?: boolean
  mergeExistingTitle?: boolean
  replaceExistingAttachments?: boolean
  eventMetadata?: Readonly<Record<string, JsonValue>>
}

export interface StoredInboundMessage {
  id: string
  conversationId: string
  attachmentCandidates: Array<{
    contentIndex: number
    id: string
  }>
  attachmentsUpdated: boolean
  contentUpdated: boolean
  created: boolean
  replacedAttachments: Array<{
    id: string
    r2Key: string | null
  }>
}

/**
 * 수신 사업자와 무관한 인박스 저장 불변식을 한 트랜잭션으로 적용한다.
 * 호출자는 사업자 페이로드를 검증하고 이 입력으로 정규화한 뒤 호출한다.
 */
export async function storeInboundMessage(
  env: Env,
  input: InboundMessageInput,
  ctx?: ExecutionContext,
): Promise<StoredInboundMessage> {
  const db = env.DB
  const customerId = createId()
  const conversationId = createId()
  const messageId = createId()
  const attachments = input.attachments ?? []

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO customers (
           id, office_id, phone_e164, name, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM messages WHERE mo_key = ?
         )
         ON CONFLICT(office_id, phone_e164) DO NOTHING`,
      )
      .bind(
        customerId,
        input.officeId,
        input.customerPhoneE164,
        input.customerPhoneE164,
        input.receivedAt,
        input.receivedAt,
        input.idempotencyKey,
      ),
    // 마이그레이션 전 복구 데이터의 미지정 대화는 첫 실제 수신 채널에 귀속한다.
    // 운영 마이그레이션은 모든 기존 행을 이미 기본 채널로 채운다.
    db
      .prepare(
        `UPDATE conversations
         SET office_channel_id = ?
         WHERE ? IS NOT NULL
           AND office_id = ?
           AND customer_id = (
             SELECT id FROM customers
             WHERE office_id = ? AND phone_e164 = ?
           )
           AND office_channel_id IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM conversations AS assigned_conversation
             WHERE assigned_conversation.office_id = ?
               AND assigned_conversation.customer_id = conversations.customer_id
               AND assigned_conversation.office_channel_id = ?
           )`,
      )
      .bind(
        input.officeChannelId,
        input.officeChannelId,
        input.officeId,
        input.officeId,
        input.customerPhoneE164,
        input.officeId,
        input.officeChannelId,
      ),
    db
      .prepare(
        `INSERT INTO conversations (
           id, office_id, customer_id, office_channel_id, status, last_message_id,
           last_message_at, created_at, updated_at
         )
         SELECT ?, ?, id, ?, '미처리', NULL, NULL, ?, ?
         FROM customers
         WHERE office_id = ?
           AND phone_e164 = ?
           AND NOT EXISTS (
             SELECT 1 FROM messages WHERE mo_key = ?
           )
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        conversationId,
        input.officeId,
        input.officeChannelId,
        input.receivedAt,
        input.receivedAt,
        input.officeId,
        input.customerPhoneE164,
        input.idempotencyKey,
      ),
    db
      .prepare(
        `INSERT INTO messages (
           id, office_id, conversation_id, direction, channel, title, body,
           sender_user_id, occurred_at, created_at, mo_key, client_key,
           msg_key, delivery_status
         )
         SELECT
           ?, ?, id, 'in', ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, '수신'
         FROM conversations
         WHERE office_id = ?
           AND customer_id = (
             SELECT id FROM customers
             WHERE office_id = ? AND phone_e164 = ?
           )
           AND office_channel_id IS ?
         ON CONFLICT(mo_key) WHERE mo_key IS NOT NULL DO NOTHING`,
      )
      .bind(
        messageId,
        input.officeId,
        input.channel,
        input.title,
        input.body,
        input.occurredAt,
        input.receivedAt,
        input.idempotencyKey,
        input.officeId,
        input.officeId,
        input.customerPhoneE164,
        input.officeChannelId,
      ),
  ]
  const messageInsertIndex = statements.length - 1
  statements.push(
    db
      .prepare(
        `UPDATE messages
         SET
           channel = CASE WHEN ? = 1 THEN ? ELSE channel END,
           title = CASE
             WHEN ? = 1 THEN COALESCE(title, ?)
             ELSE title
           END,
           body = CASE WHEN ? = 1 AND ? <> '' THEN ? ELSE body END,
           occurred_at = CASE
             WHEN ? = 1 THEN MIN(occurred_at, ?)
             ELSE occurred_at
           END
         WHERE mo_key = ?
           AND direction = 'in'
           AND (
             (? = 1 AND title IS NULL AND ? IS NOT NULL)
             OR (? = 1 AND channel <> ?)
             OR (? = 1 AND ? <> '' AND body <> ?)
             OR (? = 1 AND occurred_at > ?)
           )`,
      )
      .bind(
        input.mergeExistingBody ? 1 : 0,
        input.channel,
        input.mergeExistingTitle ? 1 : 0,
        input.title,
        input.mergeExistingBody ? 1 : 0,
        input.body,
        input.body,
        input.mergeExistingOccurredAt ? 1 : 0,
        input.occurredAt,
        input.idempotencyKey,
        input.mergeExistingTitle ? 1 : 0,
        input.title,
        input.mergeExistingBody ? 1 : 0,
        input.channel,
        input.mergeExistingBody ? 1 : 0,
        input.body,
        input.body,
        input.mergeExistingOccurredAt ? 1 : 0,
        input.occurredAt,
      ),
  )
  const contentUpdateIndex = statements.length - 1
  statements.push(
    db
      .prepare(
        `WITH target AS (
           SELECT conversation_id
           FROM messages
           WHERE mo_key = ? AND id <> ?
         ),
         latest AS (
           SELECT id, occurred_at
           FROM messages
           WHERE conversation_id = (SELECT conversation_id FROM target)
           ORDER BY occurred_at DESC, id DESC
           LIMIT 1
         )
         UPDATE conversations
         SET
           last_message_id = (SELECT id FROM latest),
           last_message_at = (SELECT occurred_at FROM latest),
           version = version + 1,
           updated_at = ?
         WHERE id = (SELECT conversation_id FROM target)
           AND ? = 1
           AND (
             last_message_id IS NOT (SELECT id FROM latest)
             OR last_message_at IS NOT (SELECT occurred_at FROM latest)
           )`,
      )
      .bind(
        input.idempotencyKey,
        messageId,
        input.receivedAt,
        input.mergeExistingOccurredAt ? 1 : 0,
      ),
  )

  let replacedAttachmentIndex: number | null = null
  if (input.replaceExistingAttachments) {
    statements.push(
      db
        .prepare(
          `DELETE FROM message_attachments
           WHERE message_id = (
             SELECT id FROM messages WHERE mo_key = ?
           )
           RETURNING id, r2_key`,
        )
        .bind(input.idempotencyKey),
    )
    replacedAttachmentIndex = statements.length - 1
  }

  const attachmentCandidates: StoredInboundMessage['attachmentCandidates'] =
    []
  const attachmentInsertIndexes: number[] = []
  for (const [position, attachment] of attachments.entries()) {
    const contentIndex = attachment.contentIndex ?? position
    const attachmentId = createId()
    attachmentCandidates.push({ contentIndex, id: attachmentId })
    statements.push(
      db
        .prepare(
          `INSERT INTO message_attachments (
             id, office_id, message_id, original_filename, byte_size,
             mime_type, r2_key, download_status, created_at, content_index,
             content_url
           )
           SELECT ?, ?, messages.id, ?, ?, ?, NULL, '대기', ?, ?, ?
           FROM messages
           WHERE messages.mo_key = ?
             AND NOT EXISTS (
               SELECT 1
               FROM message_attachments
               WHERE message_id = messages.id
                 AND content_index = ?
             )`,
        )
        .bind(
          attachmentId,
          input.officeId,
          attachment.originalFilename,
          attachment.byteSize,
          attachment.mimeType,
          input.receivedAt,
          contentIndex,
          attachment.contentUrl,
          input.idempotencyKey,
          contentIndex,
        ),
    )
    attachmentInsertIndexes.push(statements.length - 1)
    statements.push(
      db
        .prepare(
          `UPDATE message_attachments
           SET content_url = ?
           WHERE message_id = (
             SELECT id FROM messages WHERE mo_key = ?
           )
             AND content_index = ?
             AND download_status = '대기'`,
        )
        .bind(
          attachment.contentUrl,
          input.idempotencyKey,
          contentIndex,
        ),
    )
  }

  const eventPayload: Record<string, JsonValue> = {
    direction: 'in',
    channel: input.channel,
  }
  eventPayload.receptionChannelId = input.officeChannelId
  Object.assign(eventPayload, input.eventMetadata)

  const publication = publish(
    db,
    {
      officeId: input.officeId,
      type: 'message.created',
      entity: 'message',
      entityId: messageId,
      actorKind: 'customer',
      payload: eventPayload,
      createdAt: input.receivedAt,
    },
    {
      query: 'SELECT 1 FROM messages WHERE id = ? AND mo_key = ?',
      bindings: [messageId, input.idempotencyKey],
    },
  )
  statements.push(
    db
      .prepare(
        `WITH incoming AS (
           SELECT id, conversation_id, occurred_at
           FROM messages
           WHERE id = ? AND mo_key = ?
         ),
         projection AS (
           SELECT
             incoming.id,
             incoming.conversation_id,
             incoming.occurred_at,
             CASE
               WHEN conversations.last_message_at IS NULL
                 OR incoming.occurred_at > conversations.last_message_at
                 OR (
                   incoming.occurred_at = conversations.last_message_at
                   AND incoming.id > conversations.last_message_id
                 )
               THEN 1
               ELSE 0
             END AS is_latest
           FROM incoming
           JOIN conversations
             ON conversations.id = incoming.conversation_id
         )
         UPDATE conversations
         SET
           last_message_id = CASE
             WHEN (SELECT is_latest FROM projection) = 1
             THEN (SELECT id FROM projection)
             ELSE last_message_id
           END,
           last_message_at = CASE
             WHEN (SELECT is_latest FROM projection) = 1
             THEN (SELECT occurred_at FROM projection)
             ELSE last_message_at
           END,
           inbound_count = inbound_count + 1,
           status = CASE WHEN status = '완료' THEN '미처리' ELSE status END,
           version = version + 1,
           updated_at = ?
         WHERE id = (SELECT conversation_id FROM projection)`,
      )
      .bind(
        messageId,
        input.idempotencyKey,
        input.receivedAt,
      ),
    ...publication,
    db
      .prepare('DELETE FROM mo_failures WHERE mo_key = ?')
      .bind(input.idempotencyKey),
  )

  const results = await executeBatchAndBroadcast(
    db,
    statements,
    [publication],
    ctx,
    env,
  )
  const created = changes(results[messageInsertIndex]) === 1
  const contentUpdated = changes(results[contentUpdateIndex]) === 1
  const replacedAttachments =
    replacedAttachmentIndex === null
      ? []
      : (
          results[replacedAttachmentIndex]?.results as Array<{
            id: string
            r2_key: string | null
          }>
        ).map(({ id, r2_key }) => ({ id, r2Key: r2_key }))
  const attachmentsUpdated =
    replacedAttachments.length > 0 ||
    attachmentInsertIndexes.some(
      (index) => changes(results[index]) === 1,
    )

  const duplicate = await db
    .prepare(
      `SELECT id, conversation_id
       FROM messages
       WHERE mo_key = ?`,
    )
    .bind(input.idempotencyKey)
    .first<{ id: string; conversation_id: string }>()
  if (!duplicate) {
    throw new Error('수신 메시지가 커밋되지 않았습니다.')
  }
  return {
    id: duplicate.id,
    conversationId: duplicate.conversation_id,
    attachmentCandidates,
    attachmentsUpdated,
    contentUpdated,
    created,
    replacedAttachments,
  }
}
