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
}

export interface InboundMessageInput {
  officeId: string
  customerPhoneE164: string
  channel: SendChannel
  title: string | null
  body: string
  occurredAt: number
  receivedAt: number
  idempotencyKey: string
  receptionChannelId?: string | null
  attachments?: readonly InboundAttachment[]
  eventMetadata?: Readonly<Record<string, JsonValue>>
}

/**
 * 수신 사업자와 무관한 인박스 저장 불변식을 한 트랜잭션으로 적용한다.
 * 호출자는 사업자 페이로드를 검증하고 이 입력으로 정규화한 뒤 호출한다.
 */
export async function storeInboundMessage(
  env: Env,
  input: InboundMessageInput,
  ctx?: ExecutionContext,
): Promise<void> {
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
    db
      .prepare(
        `INSERT INTO conversations (
           id, office_id, customer_id, status, last_message_id,
           last_message_at, created_at, updated_at
         )
         SELECT ?, ?, id, '미처리', NULL, NULL, ?, ?
         FROM customers
         WHERE office_id = ?
           AND phone_e164 = ?
           AND NOT EXISTS (
             SELECT 1 FROM messages WHERE mo_key = ?
           )
         ON CONFLICT(office_id, customer_id) DO NOTHING`,
      )
      .bind(
        conversationId,
        input.officeId,
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
      ),
  ]
  const messageInsertIndex = statements.length - 1

  for (const [contentIndex, attachment] of attachments.entries()) {
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
          createId(),
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
  if (input.receptionChannelId !== undefined) {
    eventPayload.receptionChannelId = input.receptionChannelId
  }
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
  if (changes(results[messageInsertIndex]) === 1) return

  const duplicate = await db
    .prepare('SELECT id FROM messages WHERE mo_key = ?')
    .bind(input.idempotencyKey)
    .first<{ id: string }>()
  if (!duplicate) {
    throw new Error('수신 메시지가 커밋되지 않았습니다.')
  }
}
