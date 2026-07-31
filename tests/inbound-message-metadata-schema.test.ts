import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const NOW = 1_785_386_400_000

describe('Inbound message metadata migration', () => {
  it('adds columns without rebuilding messages and preserves canonical defaults', async () => {
    const migration = env.TEST_MIGRATIONS[10]
    if (migration === undefined) {
      throw new Error('0011 마이그레이션을 찾지 못했습니다.')
    }
    const queries = migration.queries.map((query) =>
      query.replace(/\s+/g, ' ').trim(),
    )
    expect(queries).toHaveLength(2)
    expect(
      queries.every((query) =>
        query.startsWith('ALTER TABLE messages ADD COLUMN'),
      ),
    ).toBe(true)

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
      ).bind('office-inbound-metadata', '세무법인 리치', NOW),
      env.DB.prepare(
        `INSERT INTO customers (
           id, office_id, phone_e164, name, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        'customer-inbound-metadata',
        'office-inbound-metadata',
        '+821022334455',
        '기존 고객',
        NOW,
        NOW,
      ),
      env.DB.prepare(
        `INSERT INTO conversations (
           id, office_id, customer_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        'conversation-inbound-metadata',
        'office-inbound-metadata',
        'customer-inbound-metadata',
        NOW,
        NOW,
      ),
      env.DB.prepare(
        `INSERT INTO messages (
           id, office_id, conversation_id, direction, channel, body,
           occurred_at, created_at, mo_key, delivery_status
         ) VALUES (?, ?, ?, 'in', 'MMS', ?, ?, ?, ?, '수신')`,
      ).bind(
        'message-inbound-metadata',
        'office-inbound-metadata',
        'conversation-inbound-metadata',
        '기존 문의',
        NOW,
        NOW,
        'mo-inbound-metadata',
      ),
    ])

    expect(
      await env.DB.prepare(
        `SELECT occurred_at_canonical, inbound_fingerprint
         FROM messages
         WHERE id = ?`,
      )
        .bind('message-inbound-metadata')
        .first(),
    ).toEqual({
      inbound_fingerprint: null,
      occurred_at_canonical: 1,
    })
  })
})
