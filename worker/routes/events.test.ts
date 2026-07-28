import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type {
  EventCatchupResponse,
  EventCursorGoneResponse,
} from '../../shared/wire/event'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import {
  EVENT_PAGE_LIMIT,
  EVENTS_PAGE_SQL,
} from './events'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

interface TestSession {
  officeId: string
  token: string
}

let seedSequence = 0

async function seedSession(): Promise<TestSession> {
  seedSequence += 1
  const officeId = `events-office-${seedSequence}`
  const userId = `events-user-${seedSequence}`
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
        id,
        office_id,
        email,
        name,
        title,
        role,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      officeId,
      `${userId}@rich.example`,
      '박상담',
      '상담 담당',
      '상담 담당',
      '활성',
      now,
      now,
    ),
  ])

  const session = await createSession(
    env.DB,
    { userId, officeId },
    now,
  )
  return { officeId, token: session.token }
}

function eventStatement(
  officeId: string,
  officeSeq: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO events (
      office_id,
      office_seq,
      type,
      entity,
      entity_id,
      conversation_id,
      actor_kind,
      actor_id,
      payload,
      created_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
  ).bind(
    officeId,
    officeSeq,
    'message.created',
    'message',
    `message-${officeSeq}`,
    'system',
    JSON.stringify({ position: officeSeq }),
    1_753_670_800_000 + officeSeq,
  )
}

async function appendEvents(
  officeId: string,
  first: number,
  last: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (let officeSeq = first; officeSeq <= last; officeSeq += 1) {
    statements.push(eventStatement(officeId, officeSeq))
  }
  statements.push(
    env.DB.prepare(
      'UPDATE offices SET event_seq = ? WHERE id = ?',
    ).bind(last, officeId),
  )

  for (let index = 0; index < statements.length; index += 50) {
    await env.DB.batch(statements.slice(index, index + 50))
  }
}

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function catchup(
  since: string | number | undefined,
  token?: string,
): Promise<Response> {
  const query = since === undefined ? '' : `?since=${since}`
  return SELF.fetch(`${ORIGIN}/api/events${query}`, {
    headers: token ? { cookie: cookie(token) } : undefined,
  })
}

async function body(response: Response): Promise<EventCatchupResponse> {
  return response.json<EventCatchupResponse>()
}

async function eventSequence(officeId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT event_seq FROM offices WHERE id = ?',
  )
    .bind(officeId)
    .first<{ event_seq: number }>()
  return row?.event_seq ?? 0
}

describe('Event catchup route', () => {
  it('requires a session cookie', async () => {
    const response = await catchup(0)

    expect(response.status).toBe(401)
  })

  it('returns contiguous scoped events with parsed payloads without writes', async () => {
    const session = await seedSession()
    const otherSession = await seedSession()
    await appendEvents(session.officeId, 1, 3)
    await appendEvents(otherSession.officeId, 1, 2)

    const beforeCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM events WHERE office_id = ?',
    )
      .bind(session.officeId)
      .first<{ count: number }>()
    const beforeSequence = await eventSequence(session.officeId)

    const response = await catchup(0, session.token)

    expect(response.status).toBe(200)
    const result = await body(response)
    expect(result).toEqual({
      events: [
        expect.objectContaining({
          officeSeq: 1,
          entityId: 'message-1',
          payload: { position: 1 },
        }),
        expect.objectContaining({
          officeSeq: 2,
          entityId: 'message-2',
          payload: { position: 2 },
        }),
        expect.objectContaining({
          officeSeq: 3,
          entityId: 'message-3',
          payload: { position: 3 },
        }),
      ],
      hasMore: false,
      nextCursor: 3,
    })
    expect(
      result.events.map((event) => event.officeSeq),
    ).toEqual([1, 2, 3])
    expect(
      result.events.every(
        (event) =>
          typeof event.payload === 'object' &&
          event.payload !== null,
      ),
    ).toBe(true)

    const afterCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM events WHERE office_id = ?',
    )
      .bind(session.officeId)
      .first<{ count: number }>()
    const afterSequence = await eventSequence(session.officeId)
    expect(afterCount).toEqual(beforeCount)
    expect(afterSequence).toBe(beforeSequence)
  })

  it('returns only events after the cursor in ascending order', async () => {
    const session = await seedSession()
    await appendEvents(session.officeId, 1, 5)

    const response = await catchup(2, session.token)

    expect(response.status).toBe(200)
    const result = await body(response)
    expect(
      result.events.map((event) => event.officeSeq),
    ).toEqual([3, 4, 5])
    expect(result).toMatchObject({
      hasMore: false,
      nextCursor: 5,
    })
  })

  it('continues without duplicates or omissions when new events arrive between pages', async () => {
    const session = await seedSession()
    await appendEvents(session.officeId, 1, EVENT_PAGE_LIMIT + 1)

    const firstResponse = await catchup(0, session.token)
    expect(firstResponse.status).toBe(200)
    const firstPage = await body(firstResponse)
    expect(firstPage.events).toHaveLength(EVENT_PAGE_LIMIT)
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.nextCursor).toBe(EVENT_PAGE_LIMIT)

    await appendEvents(
      session.officeId,
      EVENT_PAGE_LIMIT + 2,
      EVENT_PAGE_LIMIT + 2,
    )

    const secondResponse = await catchup(
      firstPage.nextCursor,
      session.token,
    )
    expect(secondResponse.status).toBe(200)
    const secondPage = await body(secondResponse)
    expect(secondPage.events.map((event) => event.officeSeq)).toEqual([
      EVENT_PAGE_LIMIT + 1,
      EVENT_PAGE_LIMIT + 2,
    ])
    expect(secondPage.hasMore).toBe(false)
    expect(secondPage.nextCursor).toBe(EVENT_PAGE_LIMIT + 2)

    const received = [
      ...firstPage.events,
      ...secondPage.events,
    ].map((event) => event.officeSeq)
    expect(received).toEqual(
      Array.from(
        { length: EVENT_PAGE_LIMIT + 2 },
        (_, index) => index + 1,
      ),
    )
  })

  it('returns gone when the requested history was pruned', async () => {
    const session = await seedSession()
    await appendEvents(session.officeId, 1, 4)
    await env.DB.prepare(
      'DELETE FROM events WHERE office_id = ? AND office_seq < ?',
    )
      .bind(session.officeId, 3)
      .run()
    const beforeSequence = await eventSequence(session.officeId)

    const response = await catchup(0, session.token)

    expect(response.status).toBe(410)
    const result = await response.json<EventCursorGoneResponse>()
    expect(result).toMatchObject({
      error: {
        code: 'GONE',
      },
    })
    expect(result.error.detail.currentCursor).toBe(beforeSequence)
    expect(await eventSequence(session.officeId)).toBe(
      beforeSequence,
    )
  })

  it('returns gone when the cursor is ahead of the server', async () => {
    const session = await seedSession()
    await appendEvents(session.officeId, 1, 2)
    const beforeSequence = await eventSequence(session.officeId)

    const response = await catchup(3, session.token)

    expect(response.status).toBe(410)
    const result = await response.json<EventCursorGoneResponse>()
    expect(result).toMatchObject({
      error: {
        code: 'GONE',
      },
    })
    expect(result.error.detail.currentCursor).toBe(beforeSequence)
    expect(await eventSequence(session.officeId)).toBe(
      beforeSequence,
    )

    const emptySession = await seedSession()
    const emptySequence = await eventSequence(emptySession.officeId)
    const emptyResponse = await catchup(1, emptySession.token)

    expect(emptyResponse.status).toBe(410)
    const emptyResult =
      await emptyResponse.json<EventCursorGoneResponse>()
    expect(emptyResult.error.detail.currentCursor).toBe(
      emptySequence,
    )
    expect(emptySequence).toBe(0)
    expect(await eventSequence(emptySession.officeId)).toBe(
      emptySequence,
    )
  })

  it('returns gone instead of emitting a sequence gap', async () => {
    const session = await seedSession()
    await appendEvents(session.officeId, 1, 3)
    await env.DB.prepare(
      'DELETE FROM events WHERE office_id = ? AND office_seq = ?',
    )
      .bind(session.officeId, 2)
      .run()

    const response = await catchup(0, session.token)

    expect(response.status).toBe(410)
  })

  it.each([undefined, '', '-1', '1.5', '01', '9007199254740992'])(
    'rejects the invalid cursor "$label"',
    async (value) => {
      const session = await seedSession()

      const response = await catchup(value, session.token)

      expect(response.status).toBe(400)
    },
  )

  it('uses the office sequence index for keyset pagination', async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${EVENTS_PAGE_SQL}`,
    )
      .bind('plan-office', 0, EVENT_PAGE_LIMIT + 1)
      .all<{ detail: string }>()

    expect(
      results.some((row) =>
        row.detail.includes('ux_events_office_seq'),
      ),
    ).toBe(true)
  })
})
