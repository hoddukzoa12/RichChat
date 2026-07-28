import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Status } from '../../shared/domain'
import type {
  ConversationWriteResponse,
  ConversationWriteState,
} from '../../shared/wire/conversation'
import { createSession, SESSION_COOKIE_NAME } from '../http/session'
import { createConversationWriteRoutes } from './conversation-write'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const FIXED_NOW = 1_785_229_200_123

interface Fixture {
  actorId: string
  assigneeIds: [string, string]
  conversationId: string
  officeId: string
  token: string
}

interface ConversationRow {
  status: Status
  label: string
  archived_at: number | null
  version: number
  updated_at: number
}

interface EventTotals {
  eventCount: number
  eventSeq: number
}

let seedSequence = 0

async function seedFixture(
  initialStatus: Status = '미처리',
): Promise<Fixture> {
  seedSequence += 1
  const suffix = `conversation-write-${seedSequence}`
  const officeId = `office-${suffix}`
  const actorId = `actor-${suffix}`
  const assigneeIds: [string, string] = [
    `assignee-a-${suffix}`,
    `assignee-b-${suffix}`,
  ]
  const customerId = `customer-${suffix}`
  const conversationId = `conversation-${suffix}`
  const createdAt = FIXED_NOW - 10_000

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', createdAt),
    ...[actorId, ...assigneeIds].map((userId, index) =>
      env.DB.prepare(
        `INSERT INTO users (
          id, office_id, email, name, title, role, status, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
      ).bind(
        userId,
        officeId,
        `${userId}@rich.test`,
        `상담원 ${index}`,
        '상담 담당',
        createdAt,
        createdAt,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      `+8210${String(seedSequence).padStart(8, '0')}`,
      '테스트 고객',
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      conversationId,
      officeId,
      customerId,
      initialStatus,
      createdAt,
      createdAt,
    ),
  ])

  const session = await createSession(
    env.DB,
    { userId: actorId, officeId },
    createdAt,
  )

  return {
    actorId,
    assigneeIds,
    conversationId,
    officeId,
    token: session.token,
  }
}

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function mutate(
  method: 'DELETE' | 'PATCH' | 'POST',
  path: string,
  token?: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN })
  if (token) headers.set('cookie', cookie(token))
  if (body) headers.set('content-type', 'application/json')

  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

function assigneePath(
  conversationId: string,
  userId: string,
): string {
  return `/api/conversations/${conversationId}/assignees/${userId}`
}

async function conversationRow(
  conversationId: string,
): Promise<ConversationRow | null> {
  return env.DB.prepare(
    `SELECT status, label, archived_at, version, updated_at
     FROM conversations
     WHERE id = ?`,
  )
    .bind(conversationId)
    .first<ConversationRow>()
}

async function assignees(conversationId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT user_id
     FROM conversation_assignees
     WHERE conversation_id = ?
     ORDER BY user_id`,
  )
    .bind(conversationId)
    .all<{ user_id: string }>()

  return results.map(({ user_id: userId }) => userId)
}

async function eventTotals(officeId: string): Promise<EventTotals> {
  const office = await env.DB.prepare(
    'SELECT event_seq FROM offices WHERE id = ?',
  )
    .bind(officeId)
    .first<{ event_seq: number }>()
  const events = await env.DB.prepare(
    'SELECT COUNT(*) AS event_count FROM events WHERE office_id = ?',
  )
    .bind(officeId)
    .first<{ event_count: number }>()

  return {
    eventCount: events?.event_count ?? -1,
    eventSeq: office?.event_seq ?? -1,
  }
}

async function eventTypes(officeId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT type
     FROM events
     WHERE office_id = ?
     ORDER BY office_seq`,
  )
    .bind(officeId)
    .all<{ type: string }>()

  return results.map(({ type }) => type)
}

describe('Conversation writes', () => {
  it('requires a session cookie', async () => {
    const response = await mutate(
      'PATCH',
      '/api/conversations/missing',
      undefined,
      { status: '완료', version: 1 },
    )

    expect(response.status).toBe(401)
  })

  it('increments version and returns the persisted patch', async () => {
    const fixture = await seedFixture()
    const response = await mutate(
      'PATCH',
      `/api/conversations/${fixture.conversationId}`,
      fixture.token,
      {
        status: '완료',
        label: '부가세',
        archived: true,
        version: 1,
      },
    )

    expect(response.status).toBe(200)
    const body = await response.json<ConversationWriteResponse>()
    expect(body.conversation).toMatchObject({
      id: fixture.conversationId,
      status: '완료',
      label: '부가세',
      archived: true,
      version: 2,
    })
    await expect(conversationRow(fixture.conversationId)).resolves.toMatchObject({
      status: '완료',
      label: '부가세',
      version: 2,
    })
    await expect(eventTotals(fixture.officeId)).resolves.toEqual({
      eventCount: 1,
      eventSeq: 1,
    })
  })

  it('keeps status independent from archive state', async () => {
    const fixture = await seedFixture('처리중')
    const archived = await mutate(
      'PATCH',
      `/api/conversations/${fixture.conversationId}`,
      fixture.token,
      { archived: true, version: 1 },
    )

    expect(archived.status).toBe(200)
    await expect(archived.json<ConversationWriteResponse>()).resolves.toMatchObject({
      conversation: {
        status: '처리중',
        archived: true,
        version: 2,
      },
    })

    const restored = await mutate(
      'PATCH',
      `/api/conversations/${fixture.conversationId}`,
      fixture.token,
      { archived: false, version: 2 },
    )

    expect(restored.status).toBe(200)
    await expect(restored.json<ConversationWriteResponse>()).resolves.toMatchObject({
      conversation: {
        status: '처리중',
        archived: false,
        version: 3,
      },
    })
  })

  it('returns current state and publishes nothing for a stale version', async () => {
    const fixture = await seedFixture()
    const path = `/api/conversations/${fixture.conversationId}`
    const first = await mutate('PATCH', path, fixture.token, {
      status: '처리중',
      label: '먼저 반영',
      version: 1,
    })
    expect(first.status).toBe(200)

    const before = await conversationRow(fixture.conversationId)
    const stale = await mutate('PATCH', path, fixture.token, {
      status: '완료',
      label: '뒤늦은 변경',
      archived: true,
      version: 1,
    })

    expect(stale.status).toBe(409)
    const body = await stale.json<{
      error: {
        code: string
        detail: { conversation: ConversationWriteState }
      }
    }>()
    expect(body.error.code).toBe('CONFLICT_VERSION')
    expect(body.error.detail.conversation).toMatchObject({
      status: '처리중',
      label: '먼저 반영',
      archived: false,
      version: 2,
    })
    await expect(conversationRow(fixture.conversationId)).resolves.toEqual(
      before,
    )
    await expect(eventTotals(fixture.officeId)).resolves.toEqual({
      eventCount: 1,
      eventSeq: 1,
    })
  })

  it('assigns idempotently with one row and one event', async () => {
    const fixture = await seedFixture()
    const userId = fixture.assigneeIds[0]
    const path = assigneePath(fixture.conversationId, userId)

    const first = await mutate('POST', path, fixture.token)
    const duplicate = await mutate('POST', path, fixture.token)

    expect(first.status).toBe(204)
    expect(duplicate.status).toBe(204)
    await expect(assignees(fixture.conversationId)).resolves.toEqual([
      userId,
    ])
    await expect(eventTotals(fixture.officeId)).resolves.toEqual({
      eventCount: 1,
      eventSeq: 1,
    })
  })

  it('alternates assignment directions without drifting', async () => {
    const fixture = await seedFixture()
    const userId = fixture.assigneeIds[0]
    const path = assigneePath(fixture.conversationId, userId)

    for (let index = 0; index < 3; index += 1) {
      expect((await mutate('POST', path, fixture.token)).status).toBe(204)
      expect((await mutate('DELETE', path, fixture.token)).status).toBe(204)
    }
    expect((await mutate('DELETE', path, fixture.token)).status).toBe(204)

    await expect(assignees(fixture.conversationId)).resolves.toEqual([])
    await expect(eventTotals(fixture.officeId)).resolves.toEqual({
      eventCount: 6,
      eventSeq: 6,
    })
    await expect(eventTypes(fixture.officeId)).resolves.toEqual([
      'conversation.assignee_assigned',
      'conversation.assignee_unassigned',
      'conversation.assignee_assigned',
      'conversation.assignee_unassigned',
      'conversation.assignee_assigned',
      'conversation.assignee_unassigned',
    ])
  })

  it('keeps independently assigned users', async () => {
    const fixture = await seedFixture()

    for (const userId of fixture.assigneeIds) {
      const response = await mutate(
        'POST',
        assigneePath(fixture.conversationId, userId),
        fixture.token,
      )
      expect(response.status).toBe(204)
    }

    await expect(assignees(fixture.conversationId)).resolves.toEqual(
      [...fixture.assigneeIds].sort(),
    )
    await expect(eventTotals(fixture.officeId)).resolves.toEqual({
      eventCount: 2,
      eventSeq: 2,
    })
  })

  it('returns not found for an unknown assignee without publishing', async () => {
    const fixture = await seedFixture()
    const response = await mutate(
      'POST',
      assigneePath(fixture.conversationId, 'missing-user'),
      fixture.token,
    )

    expect(response.status).toBe(404)
    await expect(eventTotals(fixture.officeId)).resolves.toEqual({
      eventCount: 0,
      eventSeq: 0,
    })
  })

  it('returns not found for unknown conversations without publishing', async () => {
    const fixture = await seedFixture()
    const missingConversationId = 'missing-conversation'
    const patch = await mutate(
      'PATCH',
      `/api/conversations/${missingConversationId}`,
      fixture.token,
      { status: '완료', version: 1 },
    )
    const assignment = await mutate(
      'POST',
      assigneePath(missingConversationId, fixture.assigneeIds[0]),
      fixture.token,
    )
    const unassignment = await mutate(
      'DELETE',
      assigneePath(missingConversationId, fixture.assigneeIds[0]),
      fixture.token,
    )

    expect(patch.status).toBe(404)
    expect(assignment.status).toBe(404)
    expect(unassignment.status).toBe(404)
    await expect(eventTotals(fixture.officeId)).resolves.toEqual({
      eventCount: 0,
      eventSeq: 0,
    })
  })

  it('uses an injected epoch millisecond clock', async () => {
    const fixture = await seedFixture('처리중')
    const route = createConversationWriteRoutes(() => FIXED_NOW).find(
      ({ method, path }) =>
        method === 'PATCH' && path === '/api/conversations/:id',
    )
    expect(route).toBeDefined()

    const response = await route?.handler(
      new Request(`${ORIGIN}/api/conversations/${fixture.conversationId}`, {
        method: 'PATCH',
        headers: {
          cookie: cookie(fixture.token),
          'content-type': 'application/json',
          origin: ORIGIN,
        },
        body: JSON.stringify({ archived: true, version: 1 }),
      }),
      env,
      { id: fixture.conversationId },
    )

    expect(response?.status).toBe(200)
    await expect(conversationRow(fixture.conversationId)).resolves.toMatchObject({
      archived_at: FIXED_NOW,
      updated_at: FIXED_NOW,
    })
  })

  it('rejects invalid patches before writing', async () => {
    const fixture = await seedFixture()
    const path = `/api/conversations/${fixture.conversationId}`
    const invalidBodies = [
      { version: 1 },
      { status: '보관', version: 1 },
      { archived: 'yes', version: 1 },
      { label: 1, version: 1 },
      { label: '부가세', version: 0 },
      { label: '부가세', version: 1, officeId: fixture.officeId },
    ]

    for (const body of invalidBodies) {
      const response = await mutate('PATCH', path, fixture.token, body)
      expect(response.status).toBe(400)
    }

    await expect(conversationRow(fixture.conversationId)).resolves.toMatchObject({
      status: '미처리',
      label: '',
      archived_at: null,
      version: 1,
    })
    await expect(eventTotals(fixture.officeId)).resolves.toEqual({
      eventCount: 0,
      eventSeq: 0,
    })
  })
})
