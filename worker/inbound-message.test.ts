import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { storeInboundMessage } from './inbound-message'

const NOW = 1_785_240_000_000

interface ConversationRow {
  office_channel_id: string
  inbound_count: number
}

async function seedOffice(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind('office-inbound-channel', '세무법인 리치', NOW),
    env.DB.prepare(
      `INSERT INTO office_channels (
        id, office_id, value, label, is_default, active, created_at, device_id
      ) VALUES (?, ?, ?, ?, 1, 1, ?, ?),
               (?, ?, ?, ?, 0, 0, ?, ?)`,
    ).bind(
      'channel-inbound-primary',
      'office-inbound-channel',
      '01011112222',
      '업무폰 1',
      NOW,
      'device-inbound-primary',
      'channel-inbound-secondary',
      'office-inbound-channel',
      '01033334444',
      '업무폰 2',
      NOW,
      'device-inbound-secondary',
    ),
  ])
}

async function store(
  officeChannelId: string,
  idempotencyKey: string,
  occurredAt: number,
): Promise<void> {
  await storeInboundMessage(env, {
    officeId: 'office-inbound-channel',
    officeChannelId,
    customerPhoneE164: '+821055556666',
    channel: 'SMS',
    title: null,
    body: idempotencyKey,
    occurredAt,
    occurredAtCanonical: true,
    receivedAt: occurredAt,
    idempotencyKey,
  })
}

describe('Inbound conversation channel split', () => {
  it('separates one customer by active or inactive channel and reuses each conversation', async () => {
    await seedOffice()

    await store('channel-inbound-primary', 'channel-mo-primary-1', NOW)
    await store(
      'channel-inbound-secondary',
      'channel-mo-secondary-1',
      NOW + 1,
    )
    await store(
      'channel-inbound-primary',
      'channel-mo-primary-2',
      NOW + 2,
    )

    const { results } = await env.DB.prepare(
      `SELECT office_channel_id, inbound_count
       FROM conversations
       WHERE office_id = ?
       ORDER BY office_channel_id`,
    )
      .bind('office-inbound-channel')
      .all<ConversationRow>()

    expect(results).toHaveLength(2)
    expect(results.map(({ office_channel_id, inbound_count }) => ({
      officeChannelId: office_channel_id,
      inboundCount: inbound_count,
    }))).toEqual([
      {
        officeChannelId: 'channel-inbound-primary',
        inboundCount: 2,
      },
      {
        officeChannelId: 'channel-inbound-secondary',
        inboundCount: 1,
      },
    ])
  })

  it('keeps status, assignment, and read cursor independent per conversation', async () => {
    await seedOffice()
    await env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    )
      .bind(
        'user-inbound-channel',
        'office-inbound-channel',
        'channel-user@rich.test',
        '박상담',
        '상담 담당',
        NOW,
        NOW,
      )
      .run()

    await store('channel-inbound-primary', 'channel-state-primary', NOW)
    await store(
      'channel-inbound-secondary',
      'channel-state-secondary',
      NOW + 1,
    )

    const conversations = await env.DB.prepare(
      `SELECT id, office_channel_id
       FROM conversations
       WHERE office_id = ?`,
    )
      .bind('office-inbound-channel')
      .all<{ id: string; office_channel_id: string }>()
    const primary = conversations.results.find(
      ({ office_channel_id }) =>
        office_channel_id === 'channel-inbound-primary',
    )
    const secondary = conversations.results.find(
      ({ office_channel_id }) =>
        office_channel_id === 'channel-inbound-secondary',
    )
    expect(primary).toBeDefined()
    expect(secondary).toBeDefined()

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE conversations
         SET status = '처리중'
         WHERE id = ?`,
      ).bind(primary!.id),
      env.DB.prepare(
        `INSERT INTO conversation_assignees (
          conversation_id, office_id, user_id, assigned_at, assigned_by
        ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        primary!.id,
        'office-inbound-channel',
        'user-inbound-channel',
        NOW,
        'user-inbound-channel',
      ),
      env.DB.prepare(
        `INSERT INTO conversation_reads (
          conversation_id, office_id, user_id, read_inbound_count, updated_at
        ) VALUES (?, ?, ?, 1, ?)`,
      ).bind(
        primary!.id,
        'office-inbound-channel',
        'user-inbound-channel',
        NOW,
      ),
    ])

    const secondaryState = await env.DB.prepare(
      `SELECT
         conversations.status,
         COUNT(DISTINCT conversation_assignees.user_id) AS assignee_count,
         COUNT(DISTINCT conversation_reads.user_id) AS read_count
       FROM conversations
       LEFT JOIN conversation_assignees
         ON conversation_assignees.conversation_id = conversations.id
       LEFT JOIN conversation_reads
         ON conversation_reads.conversation_id = conversations.id
       WHERE conversations.id = ?
       GROUP BY conversations.id`,
    )
      .bind(secondary!.id)
      .first<{
        status: string
        assignee_count: number
        read_count: number
      }>()

    expect(secondaryState).toEqual({
      status: '미처리',
      assignee_count: 0,
      read_count: 0,
    })
  })
})
