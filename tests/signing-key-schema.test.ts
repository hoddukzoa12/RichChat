import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

const NOW = 1_785_240_000_000

const APPLICATION_TABLES_IN_DROP_ORDER = [
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

async function resetToFirstNineMigrations(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys = ON'),
    ...APPLICATION_TABLES_IN_DROP_ORDER.map((table) =>
      env.DB.prepare(`DROP TABLE ${table}`),
    ),
    env.DB.prepare('DELETE FROM d1_migrations'),
    env.DB.prepare('PRAGMA defer_foreign_keys = OFF'),
  ])
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 9))
}

async function seedExistingMessage(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind('office-signing-key-upgrade', '세무법인 리치', NOW),
    env.DB.prepare(
      `INSERT INTO office_channels (
        id, office_id, value, label, device_id, is_default, active,
        created_at
      ) VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
    ).bind(
      'channel-signing-key-upgrade',
      'office-signing-key-upgrade',
      '01056129001',
      '기존 업무폰',
      'device-signing-key-upgrade',
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      'customer-signing-key-upgrade',
      'office-signing-key-upgrade',
      '+821022334455',
      '기존 고객',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, office_channel_id, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      'conversation-signing-key-upgrade',
      'office-signing-key-upgrade',
      'customer-signing-key-upgrade',
      'channel-signing-key-upgrade',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO messages (
        id, office_id, conversation_id, direction, channel, body,
        occurred_at, created_at, mo_key, delivery_status
      ) VALUES (?, ?, ?, 'in', 'SMS', ?, ?, ?, ?, '수신')`,
    ).bind(
      'message-signing-key-upgrade',
      'office-signing-key-upgrade',
      'conversation-signing-key-upgrade',
      '기존 문의',
      NOW,
      NOW,
      'mo-signing-key-upgrade',
    ),
  ])
}

async function rowCounts(): Promise<{
  conversations: number
  messages: number
}> {
  const [conversations, messages] = await env.DB.batch<{
    count: number
  }>([
    env.DB.prepare(
      'SELECT COUNT(*) AS count FROM conversations',
    ),
    env.DB.prepare('SELECT COUNT(*) AS count FROM messages'),
  ])
  return {
    conversations: conversations.results[0]?.count ?? -1,
    messages: messages.results[0]?.count ?? -1,
  }
}

beforeEach(async () => {
  await resetToFirstNineMigrations()
})

describe('Office channel signing-key migration', () => {
  it('adds a nullable column without deleting conversations or messages', async () => {
    const migration = env.TEST_MIGRATIONS[9]
    if (!migration) {
      throw new Error('서명키 마이그레이션을 찾지 못했습니다.')
    }
    await seedExistingMessage()
    const before = await rowCounts()

    await applyD1Migrations(env.DB, [migration])

    expect(await rowCounts()).toEqual(before)
    const column = await env.DB.prepare(
      `SELECT name, "notnull"
       FROM pragma_table_info('office_channels')
       WHERE name = 'signing_key'`,
    ).first<{ name: string; notnull: number }>()
    expect(column).toEqual({ name: 'signing_key', notnull: 0 })
    const channel = await env.DB.prepare(
      `SELECT device_id, signing_key
       FROM office_channels
       WHERE id = 'channel-signing-key-upgrade'`,
    ).first<{ device_id: string; signing_key: string | null }>()
    expect(channel).toEqual({
      device_id: 'device-signing-key-upgrade',
      signing_key: null,
    })
  })
})
