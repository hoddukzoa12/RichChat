import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  DELIVERY_STATUSES,
  DIRECTIONS,
  ROLES,
  SEND_CHANNELS,
  STATUSES,
  TASK_KINDS,
  USER_STATUSES,
} from '../shared/domain'

const NOW = 1_722_134_400_000

const SYSTEM_TABLES = new Set(['_cf_METADATA', 'd1_migrations'])

const TENANT_PARENT_BY_COLUMN = {
  user_id: 'users',
  updated_by: 'users',
  author_id: 'users',
  created_by: 'users',
  actor_id: 'users',
  assigned_by: 'users',
  sender_user_id: 'users',
  customer_id: 'customers',
  conversation_id: 'conversations',
} as const

const TENANT_PARENT_TABLES = new Set(['users', 'customers', 'conversations'])

const PARTIAL_INDEX_PREDICATES: Record<string, string> = {
  ux_offices_email_domain: 'WHERE email_domain IS NOT NULL',
  ux_users_works_sub: 'WHERE works_sub IS NOT NULL',
  ix_conversations_active_last_message: 'WHERE archived_at IS NULL',
  ix_conversations_archived_last_message: 'WHERE archived_at IS NOT NULL',
  ux_msg_mo_key: 'WHERE mo_key IS NOT NULL',
  ux_msg_client_key: 'WHERE client_key IS NOT NULL',
  ux_msg_msg_key: 'WHERE msg_key IS NOT NULL',
  ix_messages_pending:
    "WHERE delivery_status IN ('대기', '접수', '전송중')",
  ux_channel_default: 'WHERE is_default = 1',
}

interface SeedIds {
  officeId: string
  userId: string
  customerId: string
  conversationId: string
}

interface TableListRow {
  schema: string
  name: string
  type: string
  strict: number
}

type TenantParentTable =
  (typeof TENANT_PARENT_BY_COLUMN)[keyof typeof TENANT_PARENT_BY_COLUMN]

interface TenantGraph {
  officeId: string
  userId: string
  customerId: string
  conversationId: string
  otherOfficeId: string
  otherUserId: string
  otherCustomerId: string
  otherConversationId: string
}

interface TenantRelation {
  childTable: string
  childColumn: string
  parentTable: TenantParentTable
  hasCompoundForeignKey: boolean
}

interface ForeignKeyRow {
  id: number
  seq: number
  table: string
  from: string
  to: string
}

type TenantInsertBuilder = (
  graph: TenantGraph,
  relation: TenantRelation,
  ordinal: number,
) => D1PreparedStatement

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function sqlValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

async function applicationTables(): Promise<TableListRow[]> {
  const { results } = await env.DB.prepare('PRAGMA table_list').all<TableListRow>()

  return results.filter(
    ({ schema, name, type }) =>
      schema === 'main' &&
      type === 'table' &&
      !name.startsWith('sqlite_') &&
      !SYSTEM_TABLES.has(name),
  )
}

async function tableSql(name: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
  )
    .bind(name)
    .first<{ sql: string }>()

  expect(row).not.toBeNull()
  return normalizeSql(row?.sql ?? '')
}

async function tenantRelations(): Promise<TenantRelation[]> {
  const relations: TenantRelation[] = []

  for (const table of await applicationTables()) {
    const { results: columns } = await env.DB.prepare(
      'SELECT name FROM pragma_table_info(?)',
    )
      .bind(table.name)
      .all<{ name: string }>()
    if (!columns.some(({ name }) => name === 'office_id')) continue

    const { results: foreignKeys } = await env.DB.prepare(
      `SELECT id, seq, "table", "from", "to"
      FROM pragma_foreign_key_list(?)`,
    )
      .bind(table.name)
      .all<ForeignKeyRow>()
    const foreignKeyGroups = new Map<number, ForeignKeyRow[]>()
    for (const foreignKey of foreignKeys) {
      const group = foreignKeyGroups.get(foreignKey.id) ?? []
      group.push(foreignKey)
      foreignKeyGroups.set(foreignKey.id, group)
    }

    const candidates = new Map<string, TenantParentTable>()
    for (const column of columns) {
      if (column.name in TENANT_PARENT_BY_COLUMN) {
        const knownColumn =
          column.name as keyof typeof TENANT_PARENT_BY_COLUMN
        candidates.set(column.name, TENANT_PARENT_BY_COLUMN[knownColumn])
      }
    }
    for (const foreignKey of foreignKeys) {
      if (
        foreignKey.to === 'id' &&
        TENANT_PARENT_TABLES.has(foreignKey.table)
      ) {
        candidates.set(
          foreignKey.from,
          foreignKey.table as TenantParentTable,
        )
      }
    }

    for (const [childColumn, parentTable] of candidates) {
      const hasCompoundForeignKey = [...foreignKeyGroups.values()].some(
        (group) =>
          group.some(
            (part) =>
              part.table === parentTable &&
              part.from === childColumn &&
              part.to === 'id',
          ) &&
          group.some(
            (part) =>
              part.table === parentTable &&
              part.from === 'office_id' &&
              part.to === 'office_id',
          ),
      )

      relations.push({
        childTable: table.name,
        childColumn,
        parentTable,
        hasCompoundForeignKey,
      })
    }
  }

  return relations.sort((left, right) =>
    `${left.childTable}.${left.childColumn}`.localeCompare(
      `${right.childTable}.${right.childColumn}`,
    ),
  )
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
        id, office_id, customer_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      ids.conversationId,
      ids.officeId,
      ids.customerId,
      NOW,
      NOW,
    ),
  ])

  return ids
}

async function seedTenantGraph(suffix: string): Promise<TenantGraph> {
  const graph = {
    officeId: `office-${suffix}-1`,
    userId: `user-${suffix}-1`,
    customerId: `customer-${suffix}-1`,
    conversationId: `conversation-${suffix}-1`,
    otherOfficeId: `office-${suffix}-2`,
    otherUserId: `user-${suffix}-2`,
    otherCustomerId: `customer-${suffix}-2`,
    otherConversationId: `conversation-${suffix}-2`,
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO offices (id, name, created_at)
      VALUES (?, ?, ?), (?, ?, ?)`,
    ).bind(
      graph.officeId,
      '첫 번째 세무법인',
      NOW,
      graph.otherOfficeId,
      '두 번째 세무법인',
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      graph.userId,
      graph.officeId,
      `${suffix}-1@rich.example`,
      '첫 번째 사용자',
      '세무사',
      '세무사',
      '활성',
      NOW,
      NOW,
      graph.otherUserId,
      graph.otherOfficeId,
      `${suffix}-2@rich.example`,
      '두 번째 사용자',
      '세무사',
      '세무사',
      '활성',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    ).bind(
      graph.customerId,
      graph.officeId,
      '+821088880001',
      '첫 번째 고객',
      NOW,
      NOW,
      graph.otherCustomerId,
      graph.otherOfficeId,
      '+821088880002',
      '두 번째 고객',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    ).bind(
      graph.conversationId,
      graph.officeId,
      graph.customerId,
      NOW,
      NOW,
      graph.otherConversationId,
      graph.otherOfficeId,
      graph.otherCustomerId,
      NOW,
      NOW,
    ),
  ])

  return graph
}

function insertMessage(
  ids: SeedIds,
  values: {
    id: string
    officeId?: string
    conversationId?: string
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
    values.officeId ?? ids.officeId,
    values.conversationId ?? ids.conversationId,
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

const OTHER_ID_BY_PARENT: Record<TenantParentTable, keyof TenantGraph> = {
  users: 'otherUserId',
  customers: 'otherCustomerId',
  conversations: 'otherConversationId',
}

function crossTenantId(
  graph: TenantGraph,
  relation: TenantRelation,
): string {
  return graph[OTHER_ID_BY_PARENT[relation.parentTable]]
}

function relationValue(
  relation: TenantRelation,
  column: string,
  sameOfficeValue: string,
  otherOfficeValue: string,
): string {
  return relation.childColumn === column
    ? otherOfficeValue
    : sameOfficeValue
}

const TENANT_INSERT_BUILDERS: Record<string, TenantInsertBuilder> = {
  office_settings: (graph, relation) =>
    env.DB.prepare(
      `INSERT INTO office_settings (
        office_id, export_log, updated_at, updated_by
      ) VALUES (?, 1, ?, ?)`,
    ).bind(
      graph.officeId,
      NOW,
      relationValue(
        relation,
        'updated_by',
        graph.userId,
        graph.otherUserId,
      ),
    ),
  auth_sessions: (graph, relation, ordinal) =>
    env.DB.prepare(
      `INSERT INTO auth_sessions (
        id, user_id, office_id, created_at, expires_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      `session-tenant-${ordinal}`,
      relationValue(relation, 'user_id', graph.userId, graph.otherUserId),
      graph.officeId,
      NOW,
      NOW + 1,
      NOW,
    ),
  customer_fields: (graph, relation, ordinal) =>
    env.DB.prepare(
      `INSERT INTO customer_fields (
        id, customer_id, office_id, key, sort_order, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `field-tenant-${ordinal}`,
      relationValue(
        relation,
        'customer_id',
        graph.customerId,
        graph.otherCustomerId,
      ),
      graph.officeId,
      `key-${ordinal}`,
      ordinal,
      NOW,
      relationValue(
        relation,
        'updated_by',
        graph.userId,
        graph.otherUserId,
      ),
    ),
  conversations: (graph, relation, ordinal) =>
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      `conversation-tenant-${ordinal}`,
      graph.officeId,
      relationValue(
        relation,
        'customer_id',
        graph.customerId,
        graph.otherCustomerId,
      ),
      NOW,
      NOW,
    ),
  conversation_assignees: (graph, relation) =>
    env.DB.prepare(
      `INSERT INTO conversation_assignees (
        conversation_id, office_id, user_id, assigned_at, assigned_by
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      relationValue(
        relation,
        'conversation_id',
        graph.conversationId,
        graph.otherConversationId,
      ),
      graph.officeId,
      relationValue(relation, 'user_id', graph.userId, graph.otherUserId),
      NOW,
      relationValue(
        relation,
        'assigned_by',
        graph.userId,
        graph.otherUserId,
      ),
    ),
  conversation_reads: (graph, relation) =>
    env.DB.prepare(
      `INSERT INTO conversation_reads (
        conversation_id, office_id, user_id, updated_at
      ) VALUES (?, ?, ?, ?)`,
    ).bind(
      relationValue(
        relation,
        'conversation_id',
        graph.conversationId,
        graph.otherConversationId,
      ),
      graph.officeId,
      relationValue(relation, 'user_id', graph.userId, graph.otherUserId),
      NOW,
    ),
  messages: (graph, relation, ordinal) =>
    env.DB.prepare(
      `INSERT INTO messages (
        id, office_id, conversation_id, direction, channel, body,
        sender_user_id, occurred_at, created_at, mo_key, delivery_status
      ) VALUES (?, ?, ?, 'in', 'SMS', ?, ?, ?, ?, ?, '수신')`,
    ).bind(
      `message-tenant-${ordinal}`,
      graph.officeId,
      relationValue(
        relation,
        'conversation_id',
        graph.conversationId,
        graph.otherConversationId,
      ),
      '테넌트 경계 검증',
      relationValue(
        relation,
        'sender_user_id',
        graph.userId,
        graph.otherUserId,
      ),
      NOW,
      NOW,
      `mo-tenant-${ordinal}`,
    ),
  notes: (graph, relation, ordinal) =>
    env.DB.prepare(
      `INSERT INTO notes (
        id, office_id, conversation_id, author_id, body, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `note-tenant-${ordinal}`,
      graph.officeId,
      relationValue(
        relation,
        'conversation_id',
        graph.conversationId,
        graph.otherConversationId,
      ),
      relationValue(relation, 'author_id', graph.userId, graph.otherUserId),
      '테넌트 경계 검증',
      NOW,
      NOW,
    ),
  tasks: (graph, relation, ordinal) =>
    env.DB.prepare(
      `INSERT INTO tasks (
        id, office_id, conversation_id, name, kind, sort_order, created_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?)`,
    ).bind(
      `task-tenant-${ordinal}`,
      graph.officeId,
      relationValue(
        relation,
        'conversation_id',
        graph.conversationId,
        graph.otherConversationId,
      ),
      '테넌트 경계 검증',
      ordinal,
      relationValue(relation, 'created_by', graph.userId, graph.otherUserId),
      NOW,
      NOW,
    ),
  events: (graph, relation, ordinal) =>
    env.DB.prepare(
      `INSERT INTO events (
        office_id, office_seq, type, entity, entity_id, conversation_id,
        actor_kind, actor_id, payload, created_at
      ) VALUES (?, ?, 'created', 'message', ?, ?, 'user', ?, '{}', ?)`,
    ).bind(
      graph.officeId,
      1_000 + ordinal,
      `entity-tenant-${ordinal}`,
      relationValue(
        relation,
        'conversation_id',
        graph.conversationId,
        graph.otherConversationId,
      ),
      relationValue(relation, 'actor_id', graph.userId, graph.otherUserId),
      NOW,
    ),
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
        clientKey: 'client-sender',
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

  it('allows one default sender per office', async () => {
    const { officeId } = await seedConversation('default-channel')
    const sql = `INSERT INTO office_channels (
      id, office_id, value, is_default, active, created_at
    ) VALUES (?, ?, ?, 1, 1, ?)`

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
          id, office_id, customer_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          'conversation-duplicate',
          ids.officeId,
          ids.customerId,
          NOW,
          NOW,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/)
  })

  it('rejects a conversation linked to another office customer', async () => {
    const ids = await seedConversation('tenant-customer')
    const otherOfficeId = 'office-tenant-customer-other'
    const otherCustomerId = 'customer-tenant-customer-other'

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
      ).bind(otherOfficeId, '다른 세무법인', NOW),
      env.DB.prepare(
        `INSERT INTO customers (
          id, office_id, phone_e164, name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        otherCustomerId,
        otherOfficeId,
        '+821099990001',
        '다른 고객',
        NOW,
        NOW,
      ),
    ])

    await expect(
      env.DB.prepare(
        `INSERT INTO conversations (
          id, office_id, customer_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          'conversation-cross-office',
          ids.officeId,
          otherCustomerId,
          NOW,
          NOW,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it('rejects a message linked to another office conversation', async () => {
    const ids = await seedConversation('tenant-message')
    const otherOfficeId = 'office-tenant-message-other'

    await env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    )
      .bind(otherOfficeId, '다른 세무법인', NOW)
      .run()

    await expect(
      insertMessage(ids, {
        id: 'message-cross-office',
        officeId: otherOfficeId,
        direction: 'in',
        moKey: 'mo-cross-office',
        deliveryStatus: '수신',
      }).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it('rejects an assignee from another office', async () => {
    const ids = await seedConversation('tenant-assignee')
    const otherOfficeId = 'office-tenant-assignee-other'
    const otherUserId = 'user-tenant-assignee-other'

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
      ).bind(otherOfficeId, '다른 세무법인', NOW),
      env.DB.prepare(
        `INSERT INTO users (
          id, office_id, email, name, title, role, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        otherUserId,
        otherOfficeId,
        'other-assignee@rich.example',
        '타사 담당자',
        '세무사',
        '세무사',
        '활성',
        NOW,
        NOW,
      ),
    ])

    const sql = `INSERT INTO conversation_assignees (
      conversation_id, office_id, user_id, assigned_at, assigned_by
    ) VALUES (?, ?, ?, ?, ?)`

    await expect(
      env.DB.prepare(sql)
        .bind(
          ids.conversationId,
          otherOfficeId,
          otherUserId,
          NOW,
          otherUserId,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)

    await expect(
      env.DB.prepare(sql)
        .bind(
          ids.conversationId,
          ids.officeId,
          otherUserId,
          NOW,
          ids.userId,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it('rejects every cross-office tenant reference discovered from schema', async () => {
    const graph = await seedTenantGraph('exhaustive')
    const relations = await tenantRelations()
    const relationTables = [
      ...new Set(relations.map(({ childTable }) => childTable)),
    ].sort()

    expect(relations.length).toBeGreaterThan(0)
    expect(relationTables).toEqual(Object.keys(TENANT_INSERT_BUILDERS).sort())

    for (const [ordinal, relation] of relations.entries()) {
      const key = `${relation.childTable}.${relation.childColumn}->${relation.parentTable}.id`
      const builder = TENANT_INSERT_BUILDERS[relation.childTable]

      expect(builder, `missing INSERT builder for ${key}`).toBeDefined()
      if (!builder) throw new Error(`missing INSERT builder for ${key}`)

      await expect(
        builder(graph, relation, ordinal).run(),
        `cross-office INSERT unexpectedly succeeded for ${key}`,
      ).rejects.toThrow(/FOREIGN KEY constraint failed/)
      expect(
        relation.hasCompoundForeignKey,
        `missing compound office FK for ${key}`,
      ).toBe(true)
    }
  })

  it('rejects outbound messages without a client key', async () => {
    const ids = await seedConversation('client-required')

    await expect(
      insertMessage(ids, {
        id: 'message-client-required',
        direction: 'out',
        senderUserId: ids.userId,
        deliveryStatus: '대기',
      }).run(),
    ).rejects.toThrow(
      /CHECK constraint failed: direction = 'in' OR client_key IS NOT NULL/,
    )
  })

  it('rejects a last-message pointer to another conversation', async () => {
    const ids = await seedConversation('last-message-mismatch')
    const otherCustomerId = 'customer-last-message-other'
    const otherConversationId = 'conversation-last-message-other'
    const otherMessageId = 'message-last-message-other'

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO customers (
          id, office_id, phone_e164, name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        otherCustomerId,
        ids.officeId,
        '+821099990002',
        '다른 고객',
        NOW,
        NOW,
      ),
      env.DB.prepare(
        `INSERT INTO conversations (
          id, office_id, customer_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        otherConversationId,
        ids.officeId,
        otherCustomerId,
        NOW,
        NOW,
      ),
    ])

    await insertMessage(ids, {
      id: otherMessageId,
      conversationId: otherConversationId,
      direction: 'in',
      moKey: 'mo-last-message-other',
      deliveryStatus: '수신',
    }).run()

    await expect(
      env.DB.prepare(
        `UPDATE conversations
        SET last_message_id = ?, last_message_at = ?, updated_at = ?
        WHERE id = ?`,
      )
        .bind(otherMessageId, NOW, NOW, ids.conversationId)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it('supports the inbound message projection write order', async () => {
    const ids = await seedConversation('inbound-order')
    const messageId = 'message-inbound-order'

    await insertMessage(ids, {
      id: messageId,
      direction: 'in',
      moKey: 'mo-inbound-order',
      deliveryStatus: '수신',
    }).run()
    const update = await env.DB.prepare(
      `UPDATE conversations
      SET last_message_id = ?, last_message_at = ?, updated_at = ?
      WHERE id = ?`,
    )
      .bind(messageId, NOW, NOW, ids.conversationId)
      .run()
    const conversation = await env.DB.prepare(
      `SELECT last_message_id, last_message_at
      FROM conversations
      WHERE id = ?`,
    )
      .bind(ids.conversationId)
      .first<{ last_message_id: string; last_message_at: number }>()

    expect(update.meta.changes).toBe(1)
    expect(conversation).toEqual({
      last_message_id: messageId,
      last_message_at: NOW,
    })
  })

  it('cascades messages when deleting a conversation with a last-message pointer', async () => {
    const ids = await seedConversation('delete-cascade')
    const messageId = 'message-delete-cascade'

    await insertMessage(ids, {
      id: messageId,
      direction: 'in',
      moKey: 'mo-delete-cascade',
      deliveryStatus: '수신',
    }).run()
    await env.DB.prepare(
      `UPDATE conversations
      SET last_message_id = ?, last_message_at = ?, updated_at = ?
      WHERE id = ?`,
    )
      .bind(messageId, NOW, NOW, ids.conversationId)
      .run()

    const deletion = await env.DB.prepare(
      'DELETE FROM conversations WHERE id = ?',
    )
      .bind(ids.conversationId)
      .run()
    const remaining = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?',
    )
      .bind(ids.conversationId)
      .first<{ count: number }>()

    expect(deletion.meta.changes).toBe(2)
    expect(remaining?.count).toBe(0)
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
    const tables = await applicationTables()

    expect(tables.length).toBeGreaterThan(0)
    expect(tables.filter(({ strict }) => strict !== 1)).toEqual([])
  })

  it('keeps every time column as INTEGER', async () => {
    const tables = await applicationTables()
    const timeColumns: Array<{ table: string; column: string; type: string }> = []

    for (const table of tables) {
      const { results } = await env.DB.prepare(
        'SELECT name, type FROM pragma_table_info(?)',
      )
        .bind(table.name)
        .all<{ name: string; type: string }>()

      for (const column of results) {
        if (column.name.endsWith('_at') || column.name.endsWith('_until')) {
          timeColumns.push({
            table: table.name,
            column: column.name,
            type: column.type,
          })
        }
      }
    }

    expect(timeColumns.length).toBeGreaterThan(0)
    expect(timeColumns.filter(({ type }) => type !== 'INTEGER')).toEqual([])
  })

  it('keeps shared domain values aligned with database CHECK constraints', async () => {
    const usersSql = await tableSql('users')
    const conversationsSql = await tableSql('conversations')
    const messagesSql = await tableSql('messages')
    const tasksSql = await tableSql('tasks')

    expect(usersSql).toContain(`role IN (${sqlValues(ROLES)})`)
    expect(usersSql).toContain(`status IN (${sqlValues(USER_STATUSES)})`)
    expect(conversationsSql).toContain(`status IN (${sqlValues(STATUSES)})`)
    expect(messagesSql).toContain(`direction IN (${sqlValues(DIRECTIONS)})`)
    expect(messagesSql).toContain(`channel IN (${sqlValues(SEND_CHANNELS)})`)
    expect(messagesSql).toContain(
      `delivery_status = '${DELIVERY_STATUSES[0]}'`,
    )
    expect(messagesSql).toContain(
      `delivery_status IN (${sqlValues(DELIVERY_STATUSES.slice(1))})`,
    )
    expect(tasksSql).toContain(`kind IN (${sqlValues(TASK_KINDS)})`)
  })

  it('keeps every partial index predicate exact', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'index' AND sql LIKE '% WHERE %'`,
    ).all<{ name: string; sql: string }>()
    const actualByName = new Map(
      results.map(({ name, sql }) => [name, normalizeSql(sql)]),
    )

    expect([...actualByName.keys()].sort()).toEqual(
      Object.keys(PARTIAL_INDEX_PREDICATES).sort(),
    )
    for (const [name, predicate] of Object.entries(
      PARTIAL_INDEX_PREDICATES,
    )) {
      expect(actualByName.get(name)).toContain(predicate)
    }
  })

  it('allows multiple rows outside partial unique index predicates', async () => {
    const ids = await seedConversation('partial-null')

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
      ).bind('office-partial-null-other', '다른 세무법인', NOW),
      env.DB.prepare(
        `INSERT INTO users (
          id, office_id, email, name, title, role, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'user-partial-null-other',
        ids.officeId,
        'partial-null-other@rich.example',
        '다른 담당자',
        '세무사',
        '세무사',
        '활성',
        NOW,
        NOW,
      ),
      env.DB.prepare(
        `INSERT INTO office_channels (
          id, office_id, value, is_default, active, created_at
        ) VALUES (?, ?, ?, 0, 1, ?)`,
      ).bind('channel-partial-null-1', ids.officeId, '0211111111', NOW),
      env.DB.prepare(
        `INSERT INTO office_channels (
          id, office_id, value, is_default, active, created_at
        ) VALUES (?, ?, ?, 0, 1, ?)`,
      ).bind('channel-partial-null-2', ids.officeId, '0222222222', NOW),
    ])
    await insertMessage(ids, {
      id: 'message-partial-null-1',
      direction: 'in',
      moKey: 'mo-partial-null-1',
      deliveryStatus: '수신',
    }).run()
    await insertMessage(ids, {
      id: 'message-partial-null-2',
      direction: 'in',
      moKey: 'mo-partial-null-2',
      deliveryStatus: '수신',
    }).run()

    const messages = await env.DB.prepare(
      `SELECT COUNT(*) AS count
      FROM messages
      WHERE client_key IS NULL AND msg_key IS NULL`,
    ).first<{ count: number }>()

    expect(messages?.count).toBe(2)
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
