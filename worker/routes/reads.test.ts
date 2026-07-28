import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import { createReadRoutes } from './reads'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const INBOUND_COUNT = 5
const FIXED_NOW = 1_900_000_000_000

interface TestUser {
  id: string
  token: string
}

interface Fixture {
  conversationId: string
  officeId: string
  userA: TestUser
  userB: TestUser
}

interface StoredRead {
  read_inbound_count: number
  updated_at: number
  user_id: string
}

interface StoredEvent {
  actor_id: string
  conversation_id: string
  created_at: number
  entity: string
  entity_id: string
  payload: string
  type: string
}

let fixtureSequence = 0

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function seedFixture(): Promise<Fixture> {
  fixtureSequence += 1
  const suffix = `reads-${fixtureSequence}`
  const officeId = `office-${suffix}`
  const userAId = `user-a-${suffix}`
  const userBId = `user-b-${suffix}`
  const customerId = `customer-${suffix}`
  const conversationId = `conversation-${suffix}`
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
         id, office_id, email, name, title, role, status, created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    ).bind(
      userAId,
      officeId,
      `${userAId}@rich.test`,
      '사용자 A',
      '상담 담당',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO users (
         id, office_id, email, name, title, role, status, created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, '세무사', '활성', ?, ?)`,
    ).bind(
      userBId,
      officeId,
      `${userBId}@rich.test`,
      '사용자 B',
      '세무사',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
         id, office_id, phone_e164, name, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      `+821000${fixtureSequence.toString().padStart(6, '0')}`,
      '테스트 고객',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
         id, office_id, customer_id, inbound_count, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      conversationId,
      officeId,
      customerId,
      INBOUND_COUNT,
      now,
      now,
    ),
  ])

  const [sessionA, sessionB] = await Promise.all([
    createSession(
      env.DB,
      { userId: userAId, officeId },
      now,
    ),
    createSession(
      env.DB,
      { userId: userBId, officeId },
      now,
    ),
  ])

  return {
    conversationId,
    officeId,
    userA: { id: userAId, token: sessionA.token },
    userB: { id: userBId, token: sessionB.token },
  }
}

async function markRead(
  conversationId: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: ORIGIN,
  })
  if (token) headers.set('cookie', cookie(token))

  return SELF.fetch(
    `${ORIGIN}/api/conversations/${conversationId}/read`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

async function storedReads(
  conversationId: string,
): Promise<StoredRead[]> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, read_inbound_count, updated_at
     FROM conversation_reads
     WHERE conversation_id = ?
     ORDER BY user_id`,
  )
    .bind(conversationId)
    .all<StoredRead>()

  return results
}

async function storedEvents(officeId: string): Promise<StoredEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       type,
       entity,
       entity_id,
       conversation_id,
       actor_id,
       payload,
       created_at
     FROM events
     WHERE office_id = ?
     ORDER BY office_seq`,
  )
    .bind(officeId)
    .all<StoredEvent>()

  return results
}

describe('Conversation reads', () => {
  it('requires a session cookie', async () => {
    const response = await markRead('missing-conversation', {
      readInboundCount: 1,
    })

    expect(response.status).toBe(401)
  })

  it('inserts once and updates the existing user cursor', async () => {
    const fixture = await seedFixture()

    const first = await markRead(
      fixture.conversationId,
      { readInboundCount: 2 },
      fixture.userA.token,
    )
    expect(first.status).toBe(204)
    await expect(storedReads(fixture.conversationId)).resolves.toEqual([
      expect.objectContaining({
        user_id: fixture.userA.id,
        read_inbound_count: 2,
      }),
    ])

    const second = await markRead(
      fixture.conversationId,
      { readInboundCount: 4 },
      fixture.userA.token,
    )
    expect(second.status).toBe(204)
    await expect(storedReads(fixture.conversationId)).resolves.toEqual([
      expect.objectContaining({
        user_id: fixture.userA.id,
        read_inbound_count: 4,
      }),
    ])
  })

  it('does not move a cursor backward after a stale request', async () => {
    const fixture = await seedFixture()

    const newer = await markRead(
      fixture.conversationId,
      { readInboundCount: 4 },
      fixture.userA.token,
    )
    const stale = await markRead(
      fixture.conversationId,
      { readInboundCount: 2 },
      fixture.userA.token,
    )

    expect(newer.status).toBe(204)
    expect(stale.status).toBe(204)
    await expect(storedReads(fixture.conversationId)).resolves.toEqual([
      expect.objectContaining({
        user_id: fixture.userA.id,
        read_inbound_count: 4,
      }),
    ])
  })

  it('keeps each user cursor independent', async () => {
    const fixture = await seedFixture()
    await markRead(
      fixture.conversationId,
      { readInboundCount: 1 },
      fixture.userB.token,
    )

    const response = await markRead(
      fixture.conversationId,
      { readInboundCount: 4 },
      fixture.userA.token,
    )

    expect(response.status).toBe(204)
    await expect(storedReads(fixture.conversationId)).resolves.toEqual([
      expect.objectContaining({
        user_id: fixture.userA.id,
        read_inbound_count: 4,
      }),
      expect.objectContaining({
        user_id: fixture.userB.id,
        read_inbound_count: 1,
      }),
    ])
  })

  it('clamps a cursor to the conversation inbound count', async () => {
    const fixture = await seedFixture()

    const response = await markRead(
      fixture.conversationId,
      { readInboundCount: INBOUND_COUNT + 100 },
      fixture.userA.token,
    )

    expect(response.status).toBe(204)
    await expect(storedReads(fixture.conversationId)).resolves.toEqual([
      expect.objectContaining({
        read_inbound_count: INBOUND_COUNT,
      }),
    ])
  })

  it.each([
    { label: 'negative', value: -1 },
    { label: 'fractional', value: 1.5 },
    { label: 'string', value: '1' },
  ])('rejects a $label cursor', async ({ value }) => {
    const fixture = await seedFixture()

    const response = await markRead(
      fixture.conversationId,
      { readInboundCount: value },
      fixture.userA.token,
    )

    expect(response.status).toBe(400)
    await expect(storedReads(fixture.conversationId)).resolves.toEqual([])
    await expect(storedEvents(fixture.officeId)).resolves.toEqual([])
  })

  it('publishes only when the cursor advances', async () => {
    const fixture = await seedFixture()

    const advanced = await markRead(
      fixture.conversationId,
      { readInboundCount: 3 },
      fixture.userA.token,
    )
    expect(advanced.status).toBe(204)
    expect(await storedEvents(fixture.officeId)).toHaveLength(1)

    const repeated = await markRead(
      fixture.conversationId,
      { readInboundCount: 3 },
      fixture.userA.token,
    )
    const stale = await markRead(
      fixture.conversationId,
      { readInboundCount: 1 },
      fixture.userA.token,
    )
    const events = await storedEvents(fixture.officeId)

    expect(repeated.status).toBe(204)
    expect(stale.status).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'conversation.read',
      entity: 'conversation',
      entity_id: fixture.conversationId,
      conversation_id: fixture.conversationId,
      actor_id: fixture.userA.id,
    })
    expect(JSON.parse(events[0]?.payload ?? '')).toEqual({
      readInboundCount: 3,
    })
  })

  it('uses the session user when the body contains another user id', async () => {
    const fixture = await seedFixture()
    await markRead(
      fixture.conversationId,
      { readInboundCount: 1 },
      fixture.userB.token,
    )

    const response = await markRead(
      fixture.conversationId,
      {
        readInboundCount: 4,
        userId: fixture.userB.id,
      },
      fixture.userA.token,
    )

    expect(response.status).toBe(204)
    await expect(storedReads(fixture.conversationId)).resolves.toEqual([
      expect.objectContaining({
        user_id: fixture.userA.id,
        read_inbound_count: 4,
      }),
      expect.objectContaining({
        user_id: fixture.userB.id,
        read_inbound_count: 1,
      }),
    ])
  })

  it('returns not found for an unknown conversation without writes', async () => {
    const fixture = await seedFixture()

    const response = await markRead(
      'missing-conversation',
      { readInboundCount: 1 },
      fixture.userA.token,
    )

    expect(response.status).toBe(404)
    await expect(storedReads(fixture.conversationId)).resolves.toEqual([])
    await expect(storedEvents(fixture.officeId)).resolves.toEqual([])
  })

  it('stores injected epoch millisecond timestamps', async () => {
    const fixture = await seedFixture()
    const route = createReadRoutes(() => FIXED_NOW)[0]
    const request = new Request(
      `${ORIGIN}/api/conversations/${fixture.conversationId}/read`,
      {
        method: 'POST',
        headers: {
          cookie: cookie(fixture.userA.token),
          'content-type': 'application/json',
          origin: ORIGIN,
        },
        body: JSON.stringify({ readInboundCount: 2 }),
      },
    )

    const response = await route?.handler(request, env, {
      id: fixture.conversationId,
    })

    expect(response?.status).toBe(204)
    expect(
      (await storedReads(fixture.conversationId))[0]?.updated_at,
    ).toBe(FIXED_NOW)
    expect(
      (await storedEvents(fixture.officeId))[0]?.created_at,
    ).toBe(FIXED_NOW)
  })
})
