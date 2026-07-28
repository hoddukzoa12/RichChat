import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_DOWNLOAD_STATUSES } from '../shared/domain'

const NOW = 1_722_134_400_000

interface AttachmentSeed {
  officeId: string
  messageId: string
}

interface TableListRow {
  strict: number
}

function sqlValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

async function seedMessage(suffix: string): Promise<AttachmentSeed> {
  const officeId = `attachment-office-${suffix}`
  const customerId = `attachment-customer-${suffix}`
  const conversationId = `attachment-conversation-${suffix}`
  const messageId = `attachment-message-${suffix}`

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '리치 세무법인', NOW),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      `+82107${suffix.padStart(7, '0').slice(-7)}`,
      '첨부 고객',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(conversationId, officeId, customerId, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO messages (
        id, office_id, conversation_id, direction, channel, body,
        occurred_at, created_at, mo_key, delivery_status
      ) VALUES (?, ?, ?, 'in', 'MMS', '', ?, ?, ?, '수신')`,
    ).bind(messageId, officeId, conversationId, NOW, NOW, `mo-${suffix}`),
  ])

  return { officeId, messageId }
}

function insertPendingAttachment(
  id: string,
  officeId: string,
  messageId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO message_attachments (
      id, office_id, message_id, download_status, created_at
    ) VALUES (?, ?, ?, '대기', ?)`,
  ).bind(id, officeId, messageId, NOW)
}

describe('Attachment D1 schema', () => {
  it('creates a strict table with integer timestamps', async () => {
    const table = await env.DB.prepare(
      `SELECT strict
      FROM pragma_table_list
      WHERE schema = 'main' AND name = 'message_attachments'`,
    ).first<TableListRow>()
    const createdAt = await env.DB.prepare(
      `SELECT type
      FROM pragma_table_info('message_attachments')
      WHERE name = 'created_at'`,
    ).first<{ type: string }>()

    expect(table?.strict).toBe(1)
    expect(createdAt?.type).toBe('INTEGER')
  })

  it('keeps download statuses aligned with the shared domain', async () => {
    const table = await env.DB.prepare(
      `SELECT sql
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'message_attachments'`,
    ).first<{ sql: string }>()
    const normalizedSql = table?.sql.replace(/\s+/g, ' ') ?? ''

    expect(normalizedSql).toContain(
      `download_status IN (${sqlValues(ATTACHMENT_DOWNLOAD_STATUSES)})`,
    )
  })

  it('rejects an attachment linked to another office message', async () => {
    const first = await seedMessage('tenant-a')
    const second = await seedMessage('tenant-b')

    await expect(
      insertPendingAttachment(
        'attachment-cross-office',
        first.officeId,
        second.messageId,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it('cascades attachments when deleting a message', async () => {
    const seed = await seedMessage('cascade')

    await insertPendingAttachment(
      'attachment-cascade',
      seed.officeId,
      seed.messageId,
    ).run()
    await env.DB.prepare('DELETE FROM messages WHERE id = ?')
      .bind(seed.messageId)
      .run()

    const remaining = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM message_attachments WHERE message_id = ?',
    )
      .bind(seed.messageId)
      .first<{ count: number }>()

    expect(remaining?.count).toBe(0)
  })

  it('requires R2 metadata only after download completes', async () => {
    const seed = await seedMessage('lifecycle')

    await insertPendingAttachment(
      'attachment-pending',
      seed.officeId,
      seed.messageId,
    ).run()

    await expect(
      env.DB.prepare(
        `INSERT INTO message_attachments (
          id, office_id, message_id, original_filename, byte_size, mime_type,
          download_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, '완료', ?)`,
      )
        .bind(
          'attachment-complete-without-key',
          seed.officeId,
          seed.messageId,
          '영수증.jpg',
          1024,
          'image/jpeg',
          NOW,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('keeps legacy attachment rows valid with additive defaults', async () => {
    const seed = await seedMessage('additive-defaults')

    await insertPendingAttachment(
      'attachment-additive-defaults',
      seed.officeId,
      seed.messageId,
    ).run()

    const attachment = await env.DB.prepare(
      `SELECT download_lease_until, content_index
       FROM message_attachments
       WHERE id = ?`,
    )
      .bind('attachment-additive-defaults')
      .first<{
        download_lease_until: number
        content_index: number
      }>()

    expect(attachment).toEqual({
      download_lease_until: 0,
      content_index: 0,
    })
  })
})
