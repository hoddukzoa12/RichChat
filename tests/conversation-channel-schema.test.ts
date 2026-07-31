import {
  applyD1Migrations,
  env,
  type D1Migration,
} from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

const NOW = 1_785_240_000_000

const APPLICATION_TABLES_IN_DROP_ORDER = [
  'sms_gateway_mms_matches',
  'sms_gateway_mms_pending',
  'outbound_attachment_uploads',
  'message_attachments',
  'events',
  'lgu_tokens',
  'office_channels',
  'tasks',
  'notes',
  'messages',
  'conversation_reads',
  'conversation_assignees',
  'conversations',
  'customer_fields',
  'customers',
  'oauth_states',
  'auth_sessions',
  'office_settings',
  'user_settings',
  'users',
  'mo_failures',
  'offices',
] as const

async function resetToFirstEightMigrations(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys = ON'),
    ...APPLICATION_TABLES_IN_DROP_ORDER.map((table) =>
      env.DB.prepare(`DROP TABLE ${table}`),
    ),
    env.DB.prepare('DELETE FROM d1_migrations'),
    env.DB.prepare('PRAGMA defer_foreign_keys = OFF'),
  ])

  const firstEight = env.TEST_MIGRATIONS.slice(0, 8)
  const channelMigration = env.TEST_MIGRATIONS[8]
  if (!channelMigration) {
    throw new Error('대화 업무폰 마이그레이션을 찾지 못했습니다.')
  }
  await applyD1Migrations(env.DB, firstEight)
}

async function seedLegacyConversation(
  options: { withDefaultChannel: boolean } = {
    withDefaultChannel: true,
  },
): Promise<void> {
  const statements = [
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind('office-channel-upgrade', '세무법인 리치', NOW),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      'customer-channel-upgrade',
      'office-channel-upgrade',
      '+821011112222',
      '기존 고객',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      'conversation-channel-upgrade',
      'office-channel-upgrade',
      'customer-channel-upgrade',
      NOW,
      NOW,
    ),
  ]

  if (options.withDefaultChannel) {
    statements.splice(
      1,
      0,
      env.DB.prepare(
        `INSERT INTO office_channels (
          id, office_id, value, label, is_default, active, created_at
        ) VALUES (?, ?, ?, ?, 1, 0, ?)`,
      ).bind(
        'office-channel-default-upgrade',
        'office-channel-upgrade',
        '01011112222',
        '대표 업무폰',
        NOW,
      ),
    )
  }
  await env.DB.batch(statements)
}

beforeEach(async () => {
  await resetToFirstEightMigrations()
})

describe('Conversation office channel migration', () => {
  it('backfills every legacy conversation to the inactive default channel', async () => {
    const migration = env.TEST_MIGRATIONS[8]!
    await seedLegacyConversation()

    await applyD1Migrations(env.DB, [migration])

    const conversation = await env.DB.prepare(
      `SELECT office_channel_id
       FROM conversations
       WHERE id = ?`,
    )
      .bind('conversation-channel-upgrade')
      .first<{ office_channel_id: string }>()
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM conversations',
    ).first<{ count: number }>()

    expect(conversation?.office_channel_id).toBe(
      'office-channel-default-upgrade',
    )
    expect(count?.count).toBe(1)
    expect(
      await env.DB.prepare('PRAGMA foreign_key_check').all(),
    ).toMatchObject({ results: [] })
  })

  it('rolls back when a legacy office has no default channel', async () => {
    const migration = env.TEST_MIGRATIONS[8]!
    await seedLegacyConversation({ withDefaultChannel: false })

    await expect(
      applyD1Migrations(env.DB, [migration]),
    ).rejects.toThrow()

    const { results } = await env.DB.prepare(
      `SELECT name
       FROM pragma_table_info('conversations')
       WHERE name = 'office_channel_id'`,
    ).all<{ name: string }>()
    expect(results).toEqual([])
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM conversations',
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 })
  })

  it('uses the FK guard to roll back a deliberately broken channel reference', async () => {
    const migration = env.TEST_MIGRATIONS[8]!
    await seedLegacyConversation()
    const guardIndex = migration.queries.findIndex((query) =>
      query.includes('INSERT INTO migration_0009_fk_guard'),
    )
    expect(guardIndex).toBeGreaterThan(0)

    const brokenMigration: D1Migration = {
      name: '0009_broken_channel_reference.sql',
      queries: [...migration.queries],
    }
    brokenMigration.queries.splice(
      guardIndex,
      0,
      `DELETE FROM office_channels
       WHERE id = 'office-channel-default-upgrade'`,
    )

    await expect(
      applyD1Migrations(env.DB, [brokenMigration]),
    ).rejects.toThrow()

    const channel = await env.DB.prepare(
      'SELECT id FROM office_channels WHERE id = ?',
    )
      .bind('office-channel-default-upgrade')
      .first<{ id: string }>()
    const { results } = await env.DB.prepare(
      `SELECT name
       FROM pragma_table_info('conversations')
       WHERE name = 'office_channel_id'`,
    ).all<{ name: string }>()
    expect(channel?.id).toBe('office-channel-default-upgrade')
    expect(results).toEqual([])
  })
})
