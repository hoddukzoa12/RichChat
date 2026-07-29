import {
  applyD1Migrations,
  env,
  type D1Migration,
} from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { ROLES } from '../shared/domain'

const NOW = 1_722_134_400_000

interface ForeignKeyRow {
  id: number
  table: string
}

const USER_REFERENCE_TABLES = [
  'auth_sessions',
  'conversation_assignees',
  'conversation_reads',
  'customer_fields',
  'events',
  'messages',
  'notes',
  'office_settings',
  'tasks',
  'user_settings',
] as const

const USER_DATA_TABLES = [
  'users',
  ...USER_REFERENCE_TABLES,
] as const

const APPLICATION_TABLES_IN_DROP_ORDER = [
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

function insertUser(
  id: string,
  role: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO users (
      id, office_id, email, name, title, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '활성', ?, ?)`,
  ).bind(
    id,
    'office-role-schema',
    `${id}@rich.example`,
    id,
    role,
    role,
    NOW,
    NOW,
  )
}

async function resetToFirstFourMigrations(): Promise<D1Migration> {
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys = ON'),
    ...APPLICATION_TABLES_IN_DROP_ORDER.map((table) =>
      env.DB.prepare(`DROP TABLE ${table}`),
    ),
    env.DB.prepare('DELETE FROM d1_migrations'),
    env.DB.prepare('PRAGMA defer_foreign_keys = OFF'),
  ])

  const firstFour = env.TEST_MIGRATIONS.slice(0, 4)
  const roleMigration = env.TEST_MIGRATIONS[4]
  if (!roleMigration) {
    throw new Error('역할 마이그레이션을 찾지 못했습니다.')
  }

  await applyD1Migrations(env.DB, firstFour)
  return roleMigration
}

async function seedReferencedUserData(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO offices (id, name, created_at)
      VALUES ('office-upgrade-1', '리치 세무법인', ?),
             ('office-upgrade-2', '다른 세무법인', ?)`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, works_sub, name, title, role, status,
        created_at, updated_at
      ) VALUES
        (
          'user-upgrade-1', 'office-upgrade-1', 'upgrade-1@rich.example',
          'works-upgrade-1', '김관리', '대표', '관리자', '활성', ?, ?
        ),
        (
          'user-upgrade-2', 'office-upgrade-2', 'upgrade-2@rich.example',
          'works-upgrade-2', '이세무', '세무사', '세무사', '활성', ?, ?
        )`,
    ).bind(NOW, NOW, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO user_settings (
        user_id, notify_new_chat, notify_mine_only, notify_sound, updated_at
      ) VALUES ('user-upgrade-1', 1, 1, 1, ?)`,
    ).bind(NOW),
    env.DB.prepare(
      `INSERT INTO office_settings (
        office_id, export_log, updated_at, updated_by
      ) VALUES ('office-upgrade-1', 1, ?, 'user-upgrade-1')`,
    ).bind(NOW),
    env.DB.prepare(
      `INSERT INTO auth_sessions (
        id, user_id, office_id, created_at, expires_at, last_seen_at
      ) VALUES (
        'session-upgrade-1', 'user-upgrade-1', 'office-upgrade-1', ?, ?, ?
      )`,
    ).bind(NOW, NOW + 1, NOW),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES
        (
          'customer-upgrade-1', 'office-upgrade-1', '+821011110001',
          '첫 번째 고객', ?, ?
        ),
        (
          'customer-upgrade-2', 'office-upgrade-2', '+821011110002',
          '두 번째 고객', ?, ?
        )`,
    ).bind(NOW, NOW, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO customer_fields (
        id, customer_id, office_id, key, value, sort_order, updated_at,
        updated_by
      ) VALUES (
        'field-upgrade-1', 'customer-upgrade-1', 'office-upgrade-1',
        '업종', '서비스업', 0, ?, 'user-upgrade-1'
      )`,
    ).bind(NOW),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, created_at, updated_at
      ) VALUES
        (
          'conversation-upgrade-1', 'office-upgrade-1',
          'customer-upgrade-1', ?, ?
        ),
        (
          'conversation-upgrade-2', 'office-upgrade-2',
          'customer-upgrade-2', ?, ?
        )`,
    ).bind(NOW, NOW, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO conversation_assignees (
        conversation_id, office_id, user_id, assigned_at, assigned_by
      ) VALUES (
        'conversation-upgrade-1', 'office-upgrade-1', 'user-upgrade-1', ?,
        'user-upgrade-1'
      )`,
    ).bind(NOW),
    env.DB.prepare(
      `INSERT INTO conversation_reads (
        conversation_id, office_id, user_id, read_inbound_count, updated_at
      ) VALUES (
        'conversation-upgrade-1', 'office-upgrade-1', 'user-upgrade-1', 0, ?
      )`,
    ).bind(NOW),
    env.DB.prepare(
      `INSERT INTO messages (
        id, office_id, conversation_id, direction, channel, body,
        sender_user_id, occurred_at, created_at, client_key, delivery_status
      ) VALUES (
        'message-upgrade-1', 'office-upgrade-1', 'conversation-upgrade-1',
        'out', 'SMS', '마이그레이션 검증', 'user-upgrade-1', ?, ?,
        'client-upgrade-1', '대기'
      )`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO notes (
        id, office_id, conversation_id, author_id, body, created_at,
        updated_at
      ) VALUES (
        'note-upgrade-1', 'office-upgrade-1', 'conversation-upgrade-1',
        'user-upgrade-1', '마이그레이션 검증', ?, ?
      )`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tasks (
        id, office_id, conversation_id, name, kind, sort_order, created_by,
        created_at, updated_at
      ) VALUES (
        'task-upgrade-1', 'office-upgrade-1', 'conversation-upgrade-1',
        '마이그레이션 검증', 'idle', 0, 'user-upgrade-1', ?, ?
      )`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO events (
        office_id, office_seq, type, entity, entity_id, conversation_id,
        actor_kind, actor_id, payload, created_at
      ) VALUES (
        'office-upgrade-1', 1, 'created', 'user', 'user-upgrade-1',
        'conversation-upgrade-1', 'user', 'user-upgrade-1', '{}', ?
      )`,
    ).bind(NOW),
  ])
}

async function userDataCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}

  for (const table of USER_DATA_TABLES) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).first<{ count: number }>()
    counts[table] = row?.count ?? -1
  }

  return counts
}

describe('Role schema migration', () => {
  it('accepts every shared role and rejects unknown roles', async () => {
    await env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    )
      .bind('office-role-schema', '리치 세무법인', NOW)
      .run()

    for (const [index, role] of ROLES.entries()) {
      await expect(
        insertUser(`role-user-${index}`, role).run(),
      ).resolves.toBeDefined()
    }

    await expect(
      insertUser('role-user-unknown', '최고관리자').run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('keeps all user indexes and foreign keys', async () => {
    const { results: indexes } = await env.DB.prepare(
      `SELECT name
      FROM sqlite_schema
      WHERE type = 'index'
        AND tbl_name = 'users'
        AND sql IS NOT NULL
      ORDER BY name`,
    ).all<{ name: string }>()
    const references = new Set<string>()

    for (const table of USER_REFERENCE_TABLES) {
      const { results: foreignKeys } = await env.DB.prepare(
        `SELECT id, "table"
        FROM pragma_foreign_key_list(?)`,
      )
        .bind(table)
        .all<ForeignKeyRow>()

      for (const foreignKey of foreignKeys) {
        if (foreignKey.table === 'users') {
          references.add(`${table}:${foreignKey.id}`)
        }
      }
    }

    expect(indexes.map(({ name }) => name)).toEqual([
      'ux_users_email',
      'ux_users_id_office',
      'ux_users_works_sub',
    ])
    expect(references.size).toBe(11)
    expect(
      await env.DB.prepare('PRAGMA foreign_key_check').all(),
    ).toMatchObject({ results: [] })

    await expect(
      env.DB.prepare(
        `INSERT INTO user_settings (
          user_id, notify_new_chat, notify_mine_only, notify_sound, updated_at
        ) VALUES ('missing-user', 1, 1, 1, ?)`,
      )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it('preserves existing user reference rows during upgrade', async () => {
    const roleMigration = await resetToFirstFourMigrations()
    await seedReferencedUserData()
    const before = await userDataCounts()

    await applyD1Migrations(env.DB, [roleMigration])

    expect(await userDataCounts()).toEqual(before)
    expect(before).toEqual({
      users: 2,
      auth_sessions: 1,
      conversation_assignees: 1,
      conversation_reads: 1,
      customer_fields: 1,
      events: 1,
      messages: 1,
      notes: 1,
      office_settings: 1,
      tasks: 1,
      user_settings: 1,
    })
    expect(
      await env.DB.prepare('PRAGMA foreign_key_check').all(),
    ).toMatchObject({ results: [] })
    expect(
      await env.DB.prepare(
        `SELECT id, office_id, email, works_sub, name, title, role, status,
          created_at, updated_at
        FROM users
        ORDER BY id`,
      ).all(),
    ).toMatchObject({
      results: [
        {
          id: 'user-upgrade-1',
          office_id: 'office-upgrade-1',
          email: 'upgrade-1@rich.example',
          works_sub: 'works-upgrade-1',
          name: '김관리',
          title: '대표',
          role: '관리자',
          status: '활성',
          created_at: NOW,
          updated_at: NOW,
        },
        {
          id: 'user-upgrade-2',
          office_id: 'office-upgrade-2',
          email: 'upgrade-2@rich.example',
          works_sub: 'works-upgrade-2',
          name: '이세무',
          title: '세무사',
          role: '세무사',
          status: '활성',
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    })
  })
})
