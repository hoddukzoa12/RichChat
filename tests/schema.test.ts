import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const NOW = 1_722_134_400_000

const TABLE_NAMES = [
  'offices',
  'users',
  'user_settings',
  'office_settings',
  'auth_sessions',
  'oauth_states',
  'customers',
  'customer_fields',
  'conversations',
  'conversation_assignees',
  'conversation_reads',
  'messages',
  'mo_failures',
  'notes',
  'tasks',
  'office_channels',
  'lgu_tokens',
  'events',
] as const

interface SeedIds {
  officeId: string
  userId: string
  customerId: string
  conversationId: string
}

async function seedConversation(suffix: string): Promise<SeedIds> {
  const ids = {
    officeId: `office-${suffix}`,
    userId: `user-${suffix}`,
    customerId: `customer-${suffix}`,
    conversationId: `conversation-${suffix}`,
  }

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(ids.officeId, '리치 세무법인', NOW),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ids.userId,
      ids.officeId,
      `${suffix}@rich.example`,
      '김세무',
      '세무사',
      '세무사',
      '활성',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      ids.customerId,
      ids.officeId,
      `+8210${suffix.padStart(8, '0').slice(-8)}`,
      '홍길동',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, channel, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      ids.conversationId,
      ids.officeId,
      ids.customerId,
      '문자',
      NOW,
      NOW,
    ),
  ])

  return ids
}

function insertMessage(
  ids: SeedIds,
  values: {
    id: string
    direction: 'in' | 'out'
    senderUserId?: string | null
    moKey?: string | null
    clientKey?: string | null
    msgKey?: string | null
    deliveryStatus: string
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO messages (
      id, office_id, conversation_id, direction, channel, body,
      sender_user_id, occurred_at, created_at, mo_key, client_key, msg_key,
      delivery_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    values.id,
    ids.officeId,
    ids.conversationId,
    values.direction,
    values.direction === 'in' ? 'SMS' : 'LMS',
    '테스트 메시지',
    values.senderUserId ?? null,
    NOW,
    NOW,
    values.moKey ?? null,
    values.clientKey ?? null,
    values.msgKey ?? null,
    values.deliveryStatus,
  )
}

describe('Initial D1 schema', () => {
  it('ignores duplicate MOs with the partial unique conflict target', async () => {
    const ids = await seedConversation('mo')
    const sql = `INSERT INTO messages (
      id, office_id, conversation_id, direction, channel, body,
      occurred_at, created_at, mo_key, delivery_status
    ) VALUES (?, ?, ?, 'in', 'SMS', ?, ?, ?, ?, '수신')
    ON CONFLICT(mo_key) WHERE mo_key IS NOT NULL DO NOTHING`
    const first = await env.DB.prepare(sql)
      .bind(
        'message-mo-1',
        ids.officeId,
        ids.conversationId,
        '첫 수신',
        NOW,
        NOW,
        'same-mo-key',
      )
      .run()
    const second = await env.DB.prepare(sql)
      .bind(
        'message-mo-2',
        ids.officeId,
        ids.conversationId,
        '재전송',
        NOW,
        NOW,
        'same-mo-key',
      )
      .run()

    expect(first.meta.changes).toBe(1)
    expect(second.meta.changes).toBe(0)
  })

  it('rejects outbound messages without a sender', async () => {
    const ids = await seedConversation('sender')

    await expect(
      insertMessage(ids, {
        id: 'message-sender',
        direction: 'out',
        deliveryStatus: '대기',
      }).run(),
    ).rejects.toThrow()
  })

  it('rejects inbound messages without an MO key', async () => {
    const ids = await seedConversation('mo-required')

    await expect(
      insertMessage(ids, {
        id: 'message-mo-required',
        direction: 'in',
        deliveryStatus: '수신',
      }).run(),
    ).rejects.toThrow()
  })

  it('rejects outbound-only delivery status on inbound messages', async () => {
    const ids = await seedConversation('inbound-status')

    await expect(
      insertMessage(ids, {
        id: 'message-inbound-status',
        direction: 'in',
        moKey: 'mo-inbound-status',
        deliveryStatus: '완료',
      }).run(),
    ).rejects.toThrow()
  })

  it('allows one default sender per office and kind', async () => {
    const { officeId } = await seedConversation('default-channel')
    const sql = `INSERT INTO office_channels (
      id, office_id, kind, value, is_default, active, created_at
    ) VALUES (?, ?, 'sms_callback', ?, 1, 1, ?)`

    await env.DB.prepare(sql)
      .bind('channel-default-1', officeId, '0211111111', NOW)
      .run()

    await expect(
      env.DB.prepare(sql)
        .bind('channel-default-2', officeId, '0222222222', NOW)
        .run(),
    ).rejects.toThrow()
  })

  it('allows one conversation per customer', async () => {
    const ids = await seedConversation('one-conversation')

    await expect(
      env.DB.prepare(
        `INSERT INTO conversations (
          id, office_id, customer_id, channel, created_at, updated_at
        ) VALUES (?, ?, ?, '문자', ?, ?)`,
      )
        .bind(
          'conversation-duplicate',
          ids.officeId,
          ids.customerId,
          NOW,
          NOW,
        )
        .run(),
    ).rejects.toThrow()
  })

  it('rejects duplicate event sequences within an office', async () => {
    const { officeId } = await seedConversation('event-seq')
    const sql = `INSERT INTO events (
      office_id, office_seq, type, entity, entity_id, actor_kind, payload,
      created_at
    ) VALUES (?, 1, 'created', 'message', ?, 'system', '{}', ?)`

    await env.DB.prepare(sql).bind(officeId, 'entity-1', NOW).run()

    await expect(
      env.DB.prepare(sql).bind(officeId, 'entity-2', NOW).run(),
    ).rejects.toThrow()
  })

  it('marks every application table as STRICT', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_list').all<{
      name: string
      strict: number
    }>()
    const strictByName = new Map(
      results
        .filter(({ name }) => TABLE_NAMES.includes(name as (typeof TABLE_NAMES)[number]))
        .map(({ name, strict }) => [name, strict]),
    )

    expect([...strictByName.keys()].sort()).toEqual([...TABLE_NAMES].sort())
    expect([...strictByName.values()]).toEqual(TABLE_NAMES.map(() => 1))
  })

  it('rejects duplicate outbound idempotency and LGU+ message keys', async () => {
    const ids = await seedConversation('outbound-keys')

    await insertMessage(ids, {
      id: 'message-client-key-1',
      direction: 'out',
      senderUserId: ids.userId,
      clientKey: 'same-client-key',
      msgKey: 'msg-key-1',
      deliveryStatus: '접수',
    }).run()

    await expect(
      insertMessage(ids, {
        id: 'message-client-key-2',
        direction: 'out',
        senderUserId: ids.userId,
        clientKey: 'same-client-key',
        msgKey: 'msg-key-2',
        deliveryStatus: '접수',
      }).run(),
    ).rejects.toThrow()

    await expect(
      insertMessage(ids, {
        id: 'message-msg-key-2',
        direction: 'out',
        senderUserId: ids.userId,
        clientKey: 'client-key-2',
        msgKey: 'msg-key-1',
        deliveryStatus: '접수',
      }).run(),
    ).rejects.toThrow()
  })

  it('rejects duplicate customer phone numbers within an office', async () => {
    const ids = await seedConversation('customer-phone')

    await expect(
      env.DB.prepare(
        `INSERT INTO customers (
          id, office_id, phone_e164, name, created_at, updated_at
        )
        SELECT ?, office_id, phone_e164, ?, ?, ?
        FROM customers
        WHERE id = ?`,
      )
        .bind(
          'customer-phone-duplicate',
          '다른 고객',
          NOW,
          NOW,
          ids.customerId,
        )
        .run(),
    ).rejects.toThrow()
  })
})
