import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Status } from '../../shared/domain'
import type {
  ConversationListResponse,
} from '../../shared/wire/conversation'
import { createSession, SESSION_COOKIE_NAME } from '../http/session'
import {
  buildConversationPageQuery,
  listConversations,
} from './conversations'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const BATCH_CHUNK_SIZE = 100

interface SeededUser {
  id: string
  token: string
}

interface Fixture {
  key: string
  officeId: string
  baseTime: number
  userA: SeededUser
  userB: SeededUser
}

interface ConversationSeed {
  key: string
  name?: string
  company?: string
  phoneE164?: string
  status?: Status
  archived?: boolean
  assigneeIds?: string[]
  inboundCount?: number
  readBy?: Array<{ userId: string; count: number }>
  lastMessageAt?: number | null
  body?: string
  version?: number
}

let fixtureSequence = 0

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function seedFixture(): Promise<Fixture> {
  fixtureSequence += 1
  const key = `list-${fixtureSequence}`
  const officeId = `office-${key}`
  const userAId = `user-a-${key}`
  const userBId = `user-b-${key}`
  const now = Date.now()
  const baseTime = 1_700_000_000_000 + fixtureSequence * 10_000
  const officeChannelId = `office-channel-${key}`

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '활성', ?, ?)`,
    ).bind(
      userAId,
      officeId,
      `${userAId}@rich.example`,
      '박상담',
      '상담 담당',
      '상담 담당',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO office_channels (
        id, office_id, value, label, is_default, active, created_at
      ) VALUES (?, ?, ?, ?, 1, 1, ?)`,
    ).bind(
      officeChannelId,
      officeId,
      `0100000${String(fixtureSequence).padStart(4, '0')}`,
      '업무폰 1',
      now,
    ),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '활성', ?, ?)`,
    ).bind(
      userBId,
      officeId,
      `${userBId}@rich.example`,
      '한세무',
      '세무사',
      '세무사',
      now,
      now,
    ),
  ])

  const sessionA = await createSession(
    env.DB,
    { userId: userAId, officeId },
    now,
  )
  const sessionB = await createSession(
    env.DB,
    { userId: userBId, officeId },
    now,
  )

  return {
    key,
    officeId,
    baseTime,
    userA: { id: userAId, token: sessionA.token },
    userB: { id: userBId, token: sessionB.token },
  }
}

async function runInChunks(
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let index = 0; index < statements.length; index += BATCH_CHUNK_SIZE) {
    await env.DB.batch(statements.slice(index, index + BATCH_CHUNK_SIZE))
  }
}

async function seedConversation(
  fixture: Fixture,
  seed: ConversationSeed,
): Promise<string> {
  const id = `conversation-${fixture.key}-${seed.key}`
  const customerId = `customer-${fixture.key}-${seed.key}`
  const createdAt = fixture.baseTime
  const lastMessageAt = seed.lastMessageAt === undefined
    ? createdAt
    : seed.lastMessageAt
  const archivedAt = seed.archived ? createdAt + 1 : null
  const inboundCount = seed.inboundCount ?? (lastMessageAt === null ? 0 : 1)
  const status = seed.status ?? '미처리'
  const messageId = `message-${fixture.key}-${seed.key}`
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, company, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      fixture.officeId,
      seed.phoneE164 ?? `+82100000${fixtureSequence}${seed.key}`,
      seed.name ?? `고객 ${seed.key}`,
      seed.company ?? `상호 ${seed.key}`,
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, office_channel_id, status, label, archived_at,
        last_message_id, last_message_at, inbound_count, version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).bind(
      id,
      fixture.officeId,
      customerId,
      `office-channel-${fixture.key}`,
      status,
      `라벨 ${seed.key}`,
      archivedAt,
      inboundCount,
      seed.version ?? 1,
      createdAt,
      createdAt,
    ),
  ]

  if (lastMessageAt !== null) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO messages (
          id, office_id, conversation_id, direction, channel, body,
          occurred_at, created_at, mo_key, delivery_status
        ) VALUES (?, ?, ?, 'in', 'SMS', ?, ?, ?, ?, '수신')`,
      ).bind(
        messageId,
        fixture.officeId,
        id,
        seed.body ?? `마지막 메시지 ${seed.key}`,
        lastMessageAt,
        lastMessageAt,
        `mo-${fixture.key}-${seed.key}`,
      ),
      env.DB.prepare(
        `UPDATE conversations
        SET last_message_id = ?, last_message_at = ?
        WHERE id = ?`,
      ).bind(messageId, lastMessageAt, id),
    )
  }

  for (const [index, userId] of (seed.assigneeIds ?? []).entries()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO conversation_assignees (
          conversation_id, office_id, user_id, assigned_at, assigned_by
        ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        id,
        fixture.officeId,
        userId,
        createdAt + index,
        fixture.userA.id,
      ),
    )
  }

  for (const read of seed.readBy ?? []) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO conversation_reads (
          conversation_id, office_id, user_id, read_inbound_count, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        id,
        fixture.officeId,
        read.userId,
        read.count,
        createdAt,
      ),
    )
  }

  await env.DB.batch(statements)
  return id
}

async function addLatestMessage(
  fixture: Fixture,
  conversationId: string,
  key: string,
  occurredAt: number,
): Promise<void> {
  const messageId = `message-${fixture.key}-${key}`
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (
        id, office_id, conversation_id, direction, channel, body,
        occurred_at, created_at, mo_key, delivery_status
      ) VALUES (?, ?, ?, 'in', 'SMS', ?, ?, ?, ?, '수신')`,
    ).bind(
      messageId,
      fixture.officeId,
      conversationId,
      `새 메시지 ${key}`,
      occurredAt,
      occurredAt,
      `mo-${fixture.key}-${key}`,
    ),
    env.DB.prepare(
      `UPDATE conversations
      SET
        last_message_id = ?,
        last_message_at = ?,
        inbound_count = inbound_count + 1,
        updated_at = ?
      WHERE id = ?
        AND ? >= last_message_at`,
    ).bind(
      messageId,
      occurredAt,
      occurredAt,
      conversationId,
      occurredAt,
    ),
  ])
}

async function getList(
  token: string,
  query = '',
): Promise<ConversationListResponse> {
  const response = await SELF.fetch(
    `${ORIGIN}/api/conversations${query ? `?${query}` : ''}`,
    { headers: { cookie: cookie(token) } },
  )
  expect(response.status).toBe(200)
  return response.json<ConversationListResponse>()
}

describe('Conversation list API', () => {
  it('requires an authenticated session', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/conversations`)

    expect(response.status).toBe(401)
  })

  it('joins preview and returns unread counts per user', async () => {
    const fixture = await seedFixture()
    const conversationId = await seedConversation(fixture, {
      key: 'joined',
      name: '김리치',
      company: '리치상사',
      phoneE164: '+821012345678',
      assigneeIds: [fixture.userA.id, fixture.userB.id],
      inboundCount: 5,
      readBy: [{ userId: fixture.userA.id, count: 3 }],
      body: '세금계산서 발급 문의입니다.',
      version: 7,
    })

    const forA = await getList(fixture.userA.token)
    const forB = await getList(fixture.userB.token)

    expect(forA.conversations).toEqual([
      {
        id: conversationId,
        officeChannel: {
          id: `office-channel-${fixture.key}`,
          label: '업무폰 1',
          value: `0100000${String(fixtureSequence).padStart(4, '0')}`,
        },
        customer: {
          id: `customer-${fixture.key}-joined`,
          name: '김리치',
          company: '리치상사',
          phoneE164: '+821012345678',
        },
        preview: '세금계산서 발급 문의입니다.',
        lastMessageAt: fixture.baseTime,
        unreadCount: 2,
        assignees: [
          { id: fixture.userA.id, name: '박상담' },
          { id: fixture.userB.id, name: '한세무' },
        ],
        status: '미처리',
        label: '라벨 joined',
        archived: false,
        version: 7,
      },
    ])
    expect(forB.conversations[0]?.unreadCount).toBe(5)
  })

  it('applies every other filter to status and scope facets', async () => {
    const fixture = await seedFixture()
    await Promise.all([
      seedConversation(fixture, {
        key: 'active-open-mine',
        status: '미처리',
        assigneeIds: [fixture.userA.id],
        lastMessageAt: 600,
      }),
      seedConversation(fixture, {
        key: 'active-open-none',
        status: '미처리',
        lastMessageAt: 500,
      }),
      seedConversation(fixture, {
        key: 'active-doing-other',
        status: '처리중',
        assigneeIds: [fixture.userB.id],
        lastMessageAt: 400,
      }),
      seedConversation(fixture, {
        key: 'active-done-mine',
        status: '완료',
        assigneeIds: [fixture.userA.id],
        lastMessageAt: 300,
      }),
      seedConversation(fixture, {
        key: 'archived-open-mine',
        status: '미처리',
        archived: true,
        assigneeIds: [fixture.userA.id],
        lastMessageAt: 200,
      }),
      seedConversation(fixture, {
        key: 'archived-doing-none',
        status: '처리중',
        archived: true,
        lastMessageAt: 100,
      }),
    ])

    const active = await getList(
      fixture.userA.token,
      'status=미처리&scope=mine&limit=100',
    )
    expect(active.conversations).toHaveLength(1)
    expect(active.facets).toEqual({
      status: { 전체: 2, 미처리: 1, 처리중: 0, 완료: 1 },
      scope: { all: 2, mine: 1, none: 1 },
      archive: { active: 1, archived: 1 },
    })

    const archived = await getList(
      fixture.userA.token,
      'archived=true&status=처리중&scope=none&limit=100',
    )
    expect(archived.conversations).toHaveLength(1)
    expect(archived.facets.status.처리중).toBe(1)
    expect(archived.facets.status.미처리).toBe(0)
    expect(archived.facets.scope).toEqual({ all: 1, mine: 0, none: 1 })
    expect(archived.facets.archive).toEqual({ active: 0, archived: 1 })
  })

  it('paginates effective sort keys without duplicates or omissions', async () => {
    const fixture = await seedFixture()
    const seeded = await Promise.all([
      seedConversation(fixture, {
        key: 'a',
        lastMessageAt: fixture.baseTime + 500,
      }),
      seedConversation(fixture, {
        key: 'b',
        lastMessageAt: fixture.baseTime + 400,
      }),
      seedConversation(fixture, {
        key: 'c',
        lastMessageAt: fixture.baseTime + 400,
      }),
      seedConversation(fixture, {
        key: 'd',
        lastMessageAt: fixture.baseTime - 100,
      }),
      seedConversation(fixture, { key: 'e', lastMessageAt: null }),
      seedConversation(fixture, { key: 'f', lastMessageAt: null }),
    ])

    const received: string[] = []
    let cursor: string | null = null
    do {
      const query = new URLSearchParams({ limit: '2' })
      if (cursor) query.set('cursor', cursor)
      const page = await getList(fixture.userA.token, query.toString())
      received.push(...page.conversations.map(({ id }) => id))
      cursor = page.nextCursor
    } while (cursor)

    expect(new Set(received).size).toBe(received.length)
    expect(new Set(received)).toEqual(new Set(seeded))
    expect(received).toEqual([
      `conversation-${fixture.key}-a`,
      `conversation-${fixture.key}-c`,
      `conversation-${fixture.key}-b`,
      `conversation-${fixture.key}-f`,
      `conversation-${fixture.key}-e`,
      `conversation-${fixture.key}-d`,
    ])
    expect(
      received.filter(
        (id) =>
          !id.endsWith('-e') &&
          !id.endsWith('-f'),
      ),
    ).toEqual([
      `conversation-${fixture.key}-a`,
      `conversation-${fixture.key}-c`,
      `conversation-${fixture.key}-b`,
      `conversation-${fixture.key}-d`,
    ])
  })

  it('does not repeat a seen conversation when its sort key advances', async () => {
    const fixture = await seedFixture()
    await Promise.all([
      seedConversation(fixture, { key: 'first', lastMessageAt: 400 }),
      seedConversation(fixture, { key: 'second', lastMessageAt: 300 }),
      seedConversation(fixture, { key: 'third', lastMessageAt: 200 }),
      seedConversation(fixture, { key: 'fourth', lastMessageAt: 100 }),
    ])

    const firstPage = await getList(fixture.userA.token, 'limit=2')
    expect(firstPage.nextCursor).not.toBeNull()
    const seenIds = firstPage.conversations.map(({ id }) => id)
    await addLatestMessage(
      fixture,
      seenIds[1],
      'advanced-between-pages',
      500,
    )

    const secondPage = await getList(
      fixture.userA.token,
      new URLSearchParams({
        limit: '2',
        cursor: firstPage.nextCursor ?? '',
      }).toString(),
    )

    expect(secondPage.conversations.map(({ id }) => id)).toEqual([
      `conversation-${fixture.key}-third`,
      `conversation-${fixture.key}-fourth`,
    ])
    expect(secondPage.conversations.every(({ id }) => !seenIds.includes(id)))
      .toBe(true)
  })

  it('normalizes a Korean local phone search to E.164 digits', async () => {
    const fixture = await seedFixture()
    const matched = await seedConversation(fixture, {
      key: 'phone-match',
      phoneE164: '+821012345678',
      name: '일치 고객',
    })
    await seedConversation(fixture, {
      key: 'phone-other',
      phoneE164: '+821099998888',
      name: '다른 고객',
    })

    const result = await getList(
      fixture.userA.token,
      new URLSearchParams({ q: '010-1234' }).toString(),
    )

    expect(result.conversations.map(({ id }) => id)).toEqual([matched])
    expect(result.facets.status.전체).toBe(1)
    expect(result.facets.scope.all).toBe(1)
  })

  it('rejects malformed filters and cursors', async () => {
    const fixture = await seedFixture()

    for (const query of [
      'archived=maybe',
      'scope=other',
      'status=대기',
      'limit=0',
      'limit=101',
      'cursor=not-a-valid-cursor',
    ]) {
      const response = await SELF.fetch(`${ORIGIN}/api/conversations?${query}`, {
        headers: { cookie: cookie(fixture.userA.token) },
      })
      expect(response.status).toBe(400)
    }
  })

  it(
    'uses partial sort indexes and a fixed-size batch for a large message set',
    async () => {
      const fixture = await seedFixture()
      const customerAndConversationStatements: D1PreparedStatement[] = []
      const messageStatements: D1PreparedStatement[] = []
      const projectionStatements: D1PreparedStatement[] = []
      const firstOccurredAt = 1_710_000_000_000

      for (let conversationIndex = 0; conversationIndex < 100; conversationIndex += 1) {
        const customerId = `customer-${fixture.key}-bulk-${conversationIndex}`
        const conversationId =
          `conversation-${fixture.key}-bulk-${conversationIndex.toString().padStart(3, '0')}`
        const lastOccurredAt = firstOccurredAt + conversationIndex * 100 + 9

        customerAndConversationStatements.push(
          env.DB.prepare(
            `INSERT INTO customers (
              id, office_id, phone_e164, name, company, created_at, updated_at
            ) VALUES (?, ?, ?, ?, '', ?, ?)`,
          ).bind(
            customerId,
            fixture.officeId,
            `+82105555${conversationIndex.toString().padStart(4, '0')}`,
            `대량 고객 ${conversationIndex}`,
            firstOccurredAt,
            firstOccurredAt,
          ),
          env.DB.prepare(
            `INSERT INTO conversations (
              id, office_id, customer_id, office_channel_id, status, last_message_id,
              last_message_at, inbound_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, '미처리', NULL, NULL, 10, ?, ?)`,
          ).bind(
            conversationId,
            fixture.officeId,
            customerId,
            `office-channel-${fixture.key}`,
            firstOccurredAt,
            firstOccurredAt,
          ),
        )

        for (let messageIndex = 0; messageIndex < 10; messageIndex += 1) {
          const messageId =
            `message-${fixture.key}-bulk-${conversationIndex}-${messageIndex}`
          const occurredAt = firstOccurredAt + conversationIndex * 100 + messageIndex
          messageStatements.push(
            env.DB.prepare(
              `INSERT INTO messages (
                id, office_id, conversation_id, direction, channel, body,
                occurred_at, created_at, mo_key, delivery_status
              ) VALUES (?, ?, ?, 'in', 'SMS', ?, ?, ?, ?, '수신')`,
            ).bind(
              messageId,
              fixture.officeId,
              conversationId,
              `본문 ${conversationIndex}-${messageIndex}`,
              occurredAt,
              occurredAt,
              `mo-${fixture.key}-bulk-${conversationIndex}-${messageIndex}`,
            ),
          )
        }

        projectionStatements.push(
          env.DB.prepare(
            `UPDATE conversations
            SET last_message_id = ?, last_message_at = ?
            WHERE id = ?`,
          ).bind(
            `message-${fixture.key}-bulk-${conversationIndex}-9`,
            lastOccurredAt,
            conversationId,
          ),
        )
      }

      await runInChunks(customerAndConversationStatements)
      await runInChunks(messageStatements)
      await runInChunks(projectionStatements)

      const activeQuery = buildConversationPageQuery(
        {
          archive: 'active',
          scope: 'all',
          status: '전체',
          search: '',
          phoneSearch: '',
          limit: 100,
        },
        {
          officeId: fixture.officeId,
          userId: fixture.userA.id,
          role: '상담 담당',
        },
      )
      const activePlan = await env.DB.prepare(
        `EXPLAIN QUERY PLAN ${activeQuery.sql}`,
      )
        .bind(...activeQuery.values)
        .all<{ detail: string }>()
      const activeDetails = activePlan.results
        .map(({ detail }) => detail)
        .join('\n')
      expect(activeDetails).toContain('ix_conversations_active_last_message')
      expect(activeDetails).not.toMatch(/\bSCAN (?:messages|last_message)\b/)
      expect(activeDetails).toMatch(/\bSEARCH last_message\b/)

      await seedConversation(fixture, {
        key: 'archived-plan',
        archived: true,
        lastMessageAt: firstOccurredAt,
      })
      const archivedQuery = buildConversationPageQuery(
        {
          archive: 'archived',
          scope: 'all',
          status: '전체',
          search: '',
          phoneSearch: '',
          limit: 100,
        },
        {
          officeId: fixture.officeId,
          userId: fixture.userA.id,
          role: '상담 담당',
        },
      )
      const archivedPlan = await env.DB.prepare(
        `EXPLAIN QUERY PLAN ${archivedQuery.sql}`,
      )
        .bind(...archivedQuery.values)
        .all<{ detail: string }>()
      expect(archivedPlan.results.map(({ detail }) => detail).join('\n'))
        .toContain('ix_conversations_archived_last_message')

      const batchSizes: number[] = []
      const tracedDb = {
        prepare: env.DB.prepare.bind(env.DB),
        batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
          batchSizes.push(statements.length)
          return env.DB.batch<T>(statements)
        },
      } as D1Database
      const tracedEnv = new Proxy(env, {
        get(target, property, receiver) {
          if (property === 'DB') return tracedDb
          return Reflect.get(target, property, receiver)
        },
      })
      const response = await listConversations(
        new Request(`${ORIGIN}/api/conversations?limit=100`, {
          headers: { cookie: cookie(fixture.userA.token) },
        }),
        tracedEnv,
      )
      const body = await response.json<ConversationListResponse>()

      expect(response.status).toBe(200)
      expect(body.conversations).toHaveLength(100)
      expect(batchSizes).toEqual([4])
    },
    30_000,
  )
})
