import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { NoteResponse } from '../../shared/wire/note'
import { createSession, SESSION_COOKIE_NAME } from '../http/session'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

interface TestUser {
  id: string
  name: string
  token: string
}

interface Fixture {
  conversationId: string
  otherConversationId: string
  officeId: string
  owner: TestUser
  otherUser: TestUser
}

interface StoredNote {
  author_id: string
  body: string
  deleted_at: number | null
  updated_at: number
}

let fixtureSequence = 0

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function seedFixture(): Promise<Fixture> {
  fixtureSequence += 1
  const suffix = `notes-${fixtureSequence}`
  const officeId = `office-${suffix}`
  const ownerId = `owner-${suffix}`
  const otherUserId = `other-user-${suffix}`
  const customerId = `customer-${suffix}`
  const otherCustomerId = `other-customer-${suffix}`
  const conversationId = `conversation-${suffix}`
  const otherConversationId = `other-conversation-${suffix}`
  const now = 1_800_000_000_000 + fixtureSequence

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    ).bind(
      ownerId,
      officeId,
      `${ownerId}@rich.test`,
      '작성자',
      '상담 담당',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    ).bind(
      otherUserId,
      officeId,
      `${otherUserId}@rich.test`,
      '동명이 아닌 직원',
      '상담 담당',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      `+8210000${fixtureSequence.toString().padStart(4, '0')}`,
      '고객',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      otherCustomerId,
      officeId,
      `+8211000${fixtureSequence.toString().padStart(4, '0')}`,
      '다른 고객',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(conversationId, officeId, customerId, now, now),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      otherConversationId,
      officeId,
      otherCustomerId,
      now,
      now,
    ),
  ])

  const ownerSession = await createSession(
    env.DB,
    { userId: ownerId, officeId },
    now,
  )
  const otherSession = await createSession(
    env.DB,
    { userId: otherUserId, officeId },
    now,
  )

  return {
    conversationId,
    otherConversationId,
    officeId,
    owner: { id: ownerId, name: '작성자', token: ownerSession.token },
    otherUser: {
      id: otherUserId,
      name: '동명이 아닌 직원',
      token: otherSession.token,
    },
  }
}

async function request(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN })
  if (token) headers.set('cookie', cookie(token))
  if (body !== undefined) headers.set('content-type', 'application/json')

  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function createNote(
  fixture: Fixture,
  token = fixture.owner.token,
  body = '내부 메모',
): Promise<NoteResponse['note']> {
  const response = await request(
    'POST',
    `/api/conversations/${fixture.conversationId}/notes`,
    token,
    { body },
  )

  expect(response.status).toBe(201)
  const payload = await response.json<NoteResponse>()
  return payload.note
}

async function storedNote(noteId: string): Promise<StoredNote | null> {
  return env.DB.prepare(
    `SELECT author_id, body, deleted_at, updated_at
    FROM notes
    WHERE id = ?`,
  )
    .bind(noteId)
    .first<StoredNote>()
}

async function eventCount(noteId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
    FROM events
    WHERE entity_id = ?`,
  )
    .bind(noteId)
    .first<{ count: number }>()

  return row?.count ?? 0
}

async function officeEventSequence(officeId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT event_seq FROM offices WHERE id = ?',
  )
    .bind(officeId)
    .first<{ event_seq: number }>()

  return row?.event_seq ?? 0
}

describe('Conversation notes', () => {
  it.each([
    { method: 'POST' as const, suffix: '', body: { body: '메모' } },
    {
      method: 'PATCH' as const,
      suffix: '/missing-note',
      body: { body: '메모' },
    },
    {
      method: 'DELETE' as const,
      suffix: '/missing-note',
      body: undefined,
    },
  ])(
    'rejects an unauthenticated $method request',
    async ({ method, suffix, body }) => {
      const fixture = await seedFixture()

      const response = await request(
        method,
        `/api/conversations/${fixture.conversationId}/notes${suffix}`,
        undefined,
        body,
      )

      expect(response.status).toBe(401)
    },
  )

  it('creates a note from the session author', async () => {
    const fixture = await seedFixture()

    const note = await createNote(
      fixture,
      fixture.owner.token,
      '  고객에게 보이지 않는 메모  ',
    )

    expect(note).toMatchObject({
      authorId: fixture.owner.id,
      authorName: fixture.owner.name,
      body: '고객에게 보이지 않는 메모',
    })
    expect(note.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect((await storedNote(note.id))?.author_id).toBe(
      fixture.owner.id,
    )
    expect(await eventCount(note.id)).toBe(1)
  })

  it('does not accept an author from the request body', async () => {
    const fixture = await seedFixture()

    const response = await request(
      'POST',
      `/api/conversations/${fixture.conversationId}/notes`,
      fixture.owner.token,
      { body: '메모', authorId: fixture.otherUser.id },
    )

    expect(response.status).toBe(400)
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM notes WHERE conversation_id = ?',
    )
      .bind(fixture.conversationId)
      .first<{ count: number }>()
    expect(count?.count).toBe(0)
  })

  it('rejects whitespace-only bodies', async () => {
    const fixture = await seedFixture()

    const createResponse = await request(
      'POST',
      `/api/conversations/${fixture.conversationId}/notes`,
      fixture.owner.token,
      { body: ' \n\t ' },
    )
    expect(createResponse.status).toBe(400)

    const note = await createNote(fixture)
    const updateResponse = await request(
      'PATCH',
      `/api/conversations/${fixture.conversationId}/notes/${note.id}`,
      fixture.owner.token,
      { body: '   ' },
    )
    expect(updateResponse.status).toBe(400)
    expect((await storedNote(note.id))?.body).toBe('내부 메모')
  })

  it('forbids another author from updating a note', async () => {
    const fixture = await seedFixture()
    const note = await createNote(fixture)
    const sequenceBefore = await officeEventSequence(fixture.officeId)

    const response = await request(
      'PATCH',
      `/api/conversations/${fixture.conversationId}/notes/${note.id}`,
      fixture.otherUser.token,
      { body: '남이 덮어쓴 본문' },
    )

    expect(response.status).toBe(403)
    expect((await storedNote(note.id))?.body).toBe('내부 메모')
    expect(await eventCount(note.id)).toBe(1)
    expect(await officeEventSequence(fixture.officeId)).toBe(
      sequenceBefore,
    )
  })

  it('forbids another author from deleting a note', async () => {
    const fixture = await seedFixture()
    const note = await createNote(fixture)
    const sequenceBefore = await officeEventSequence(fixture.officeId)

    const response = await request(
      'DELETE',
      `/api/conversations/${fixture.conversationId}/notes/${note.id}`,
      fixture.otherUser.token,
    )

    expect(response.status).toBe(403)
    expect((await storedNote(note.id))?.deleted_at).toBeNull()
    expect(await eventCount(note.id)).toBe(1)
    expect(await officeEventSequence(fixture.officeId)).toBe(
      sequenceBefore,
    )
  })

  it('does not distinguish a missing note from another author note', async () => {
    const fixture = await seedFixture()
    const note = await createNote(fixture)

    const foreignResponse = await request(
      'PATCH',
      `/api/conversations/${fixture.conversationId}/notes/${note.id}`,
      fixture.otherUser.token,
      { body: '변경 시도' },
    )
    const missingResponse = await request(
      'PATCH',
      `/api/conversations/${fixture.conversationId}/notes/missing-note`,
      fixture.otherUser.token,
      { body: '변경 시도' },
    )

    expect(missingResponse.status).toBe(403)
    expect(await missingResponse.json()).toEqual(
      await foreignResponse.json(),
    )
  })

  it('keeps author ownership after a display-name change', async () => {
    const fixture = await seedFixture()
    const note = await createNote(fixture)

    await env.DB.prepare(
      'UPDATE users SET name = ?, updated_at = ? WHERE id = ?',
    )
      .bind('개명한 작성자', Date.now(), fixture.owner.id)
      .run()

    const response = await request(
      'PATCH',
      `/api/conversations/${fixture.conversationId}/notes/${note.id}`,
      fixture.owner.token,
      { body: '개명 후에도 수정 가능' },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      note: {
        authorId: fixture.owner.id,
        authorName: '개명한 작성자',
        body: '개명 후에도 수정 가능',
      },
    })
    expect(await eventCount(note.id)).toBe(2)
  })

  it('soft-deletes a note and excludes it from active reads', async () => {
    const fixture = await seedFixture()
    const note = await createNote(fixture)

    const response = await request(
      'DELETE',
      `/api/conversations/${fixture.conversationId}/notes/${note.id}`,
      fixture.owner.token,
    )

    expect(response.status).toBe(204)
    const stored = await storedNote(note.id)
    expect(stored).not.toBeNull()
    expect(stored?.deleted_at).toEqual(expect.any(Number))

    // B7 상세 조회가 사용하는 활성 행 조건과 같은 조건으로 검증한다.
    const active = await env.DB.prepare(
      `SELECT id
      FROM notes
      WHERE id = ?
        AND conversation_id = ?
        AND deleted_at IS NULL`,
    )
      .bind(note.id, fixture.conversationId)
      .first()
    expect(active).toBeNull()
    expect(await eventCount(note.id)).toBe(2)
  })

  it.each([
    {
      method: 'PATCH' as const,
      body: { body: '다른 대화 경로로 변경' },
    },
    {
      method: 'DELETE' as const,
      body: undefined,
    },
  ])(
    'does not allow $method through another conversation path',
    async ({ method, body }) => {
      const fixture = await seedFixture()
      const note = await createNote(fixture)
      const sequenceBefore = await officeEventSequence(fixture.officeId)

      const response = await request(
        method,
        `/api/conversations/${fixture.otherConversationId}/notes/${note.id}`,
        fixture.owner.token,
        body,
      )

      expect(response.status).toBe(404)
      expect(await storedNote(note.id)).toMatchObject({
        body: '내부 메모',
        deleted_at: null,
      })
      expect(await eventCount(note.id)).toBe(1)
      expect(await officeEventSequence(fixture.officeId)).toBe(
        sequenceBefore,
      )
    },
  )

  it('publishes one event for each successful change', async () => {
    const fixture = await seedFixture()
    const note = await createNote(fixture)

    const updateResponse = await request(
      'PATCH',
      `/api/conversations/${fixture.conversationId}/notes/${note.id}`,
      fixture.owner.token,
      { body: '수정된 메모' },
    )
    expect(updateResponse.status).toBe(200)

    const deleteResponse = await request(
      'DELETE',
      `/api/conversations/${fixture.conversationId}/notes/${note.id}`,
      fixture.owner.token,
    )
    expect(deleteResponse.status).toBe(204)

    expect(await eventCount(note.id)).toBe(3)
  })

  it('returns the same response for repeated deletion', async () => {
    const fixture = await seedFixture()
    const note = await createNote(fixture)

    const first = await request(
      'DELETE',
      `/api/conversations/${fixture.conversationId}/notes/${note.id}`,
      fixture.owner.token,
    )
    const sequenceAfterFirst = await officeEventSequence(
      fixture.officeId,
    )
    const second = await request(
      'DELETE',
      `/api/conversations/${fixture.conversationId}/notes/${note.id}`,
      fixture.owner.token,
    )

    expect(first.status).toBe(204)
    expect(second.status).toBe(403)
    expect((await storedNote(note.id))?.deleted_at).not.toBeNull()
    expect(await eventCount(note.id)).toBe(2)
    expect(await officeEventSequence(fixture.officeId)).toBe(
      sequenceAfterFirst,
    )
  })

  it('does not publish an event for a missing-note update', async () => {
    const fixture = await seedFixture()
    const sequenceBefore = await officeEventSequence(fixture.officeId)

    const response = await request(
      'PATCH',
      `/api/conversations/${fixture.conversationId}/notes/missing-note`,
      fixture.owner.token,
      { body: '존재하지 않는 메모 수정' },
    )

    expect(response.status).toBe(403)
    expect(await eventCount('missing-note')).toBe(0)
    expect(await officeEventSequence(fixture.officeId)).toBe(
      sequenceBefore,
    )
  })
})
