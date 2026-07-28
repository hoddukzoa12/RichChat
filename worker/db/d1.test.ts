import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { changes, D1BatchError, executeBatch } from './d1'
import { publish, type EventInput } from './events'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const NOW = 1_753_670_800_123
const OFFICE_NAME = '리치 세무법인'

function insertOffice(id: string): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
  ).bind(id, OFFICE_NAME, NOW)
}

function insertUser(id: string, officeId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO users (
      id, office_id, email, name, title, role, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    officeId,
    `${id}@rich.test`,
    '테스트 상담원',
    '상담 담당',
    '상담 담당',
    '활성',
    NOW,
    NOW,
  )
}

function insertCustomer(id: string, officeId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO customers (
      id, office_id, phone_e164, name, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, officeId, '+821000000000', '테스트 고객', NOW, NOW)
}

function insertConversation(
  id: string,
  officeId: string,
  customerId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO conversations (
      id, office_id, customer_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, officeId, customerId, NOW, NOW)
}

async function expectNoPublishedEvent(officeId: string): Promise<void> {
  const office = await env.DB.prepare(
    'SELECT event_seq FROM offices WHERE id = ?',
  )
    .bind(officeId)
    .first<{ event_seq: number }>()
  const storedEvents = await env.DB.prepare(
    'SELECT COUNT(*) AS event_count FROM events WHERE office_id = ?',
  )
    .bind(officeId)
    .first<{ event_count: number }>()

  expect(office?.event_seq).toBe(0)
  expect(storedEvents?.event_count).toBe(0)
}

function event(officeId: string, entityId: string): EventInput {
  return {
    officeId,
    type: 'message.created',
    entity: 'message',
    entityId,
    actorKind: 'system',
    payload: { entityId },
    createdAt: NOW,
  }
}

describe('D1 helpers', () => {
  it('reports changes without interpreting zero', async () => {
    const officeId = 'office-changes'
    const sql = `INSERT INTO offices (id, name, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO NOTHING`
    const first = await env.DB.prepare(sql)
      .bind(officeId, '리치 세무법인', NOW)
      .run()
    const duplicate = await env.DB.prepare(sql)
      .bind(officeId, '리치 세무법인', NOW)
      .run()

    expect(changes(first)).toBe(1)
    expect(changes(duplicate)).toBe(0)
  })

  it('rolls back publish statements with the caller batch', async () => {
    const officeId = 'office-rollback'
    await insertOffice(officeId).run()
    const statements = publish(env.DB, event(officeId, 'message-rollback'))

    expect(statements).toHaveLength(2)
    await expect(
      executeBatch(env.DB, [
        ...statements,
        env.DB.prepare(
          'INSERT INTO offices (id, name, created_at) VALUES (?, NULL, ?)',
        ).bind('office-invalid', NOW),
      ]),
    ).rejects.toBeInstanceOf(D1BatchError)

    const office = await env.DB.prepare(
      'SELECT event_seq FROM offices WHERE id = ?',
    )
      .bind(officeId)
      .first<{ event_seq: number }>()
    const storedEvent = await env.DB.prepare(
      'SELECT office_seq FROM events WHERE office_id = ?',
    )
      .bind(officeId)
      .first<{ office_seq: number }>()

    expect(office?.event_seq).toBe(0)
    expect(storedEvent).toBeNull()
  })

  it('assigns contiguous sequences independently per office', async () => {
    const firstOfficeId = 'office-sequence-a'
    const secondOfficeId = 'office-sequence-b'
    await executeBatch(env.DB, [
      insertOffice(firstOfficeId),
      insertOffice(secondOfficeId),
    ])

    await executeBatch(env.DB, [
      ...publish(env.DB, event(firstOfficeId, 'message-a1')),
      ...publish(env.DB, event(firstOfficeId, 'message-a2')),
      ...publish(env.DB, event(secondOfficeId, 'message-b1')),
    ])

    const { results: events } = await env.DB.prepare(
      `SELECT office_id, office_seq
       FROM events
       WHERE office_id IN (?, ?)
       ORDER BY office_id, office_seq`,
    )
      .bind(firstOfficeId, secondOfficeId)
      .all<{ office_id: string; office_seq: number }>()
    const { results: offices } = await env.DB.prepare(
      `SELECT id, event_seq
       FROM offices
       WHERE id IN (?, ?)
       ORDER BY id`,
    )
      .bind(firstOfficeId, secondOfficeId)
      .all<{ id: string; event_seq: number }>()

    expect(events).toEqual([
      { office_id: firstOfficeId, office_seq: 1 },
      { office_id: firstOfficeId, office_seq: 2 },
      { office_id: secondOfficeId, office_seq: 1 },
    ])
    expect(offices).toEqual([
      { id: firstOfficeId, event_seq: 2 },
      { id: secondOfficeId, event_seq: 1 },
    ])
  })

  it('skips an event for an idempotent assignee reinsertion', async () => {
    const officeId = 'office-guard-assignee'
    const userId = 'user-guard-assignee'
    const customerId = 'customer-guard-assignee'
    const conversationId = 'conversation-guard-assignee'
    const attemptedAssignedAt = NOW + 1

    await executeBatch(env.DB, [
      insertOffice(officeId),
      insertUser(userId, officeId),
      insertCustomer(customerId, officeId),
      insertConversation(conversationId, officeId, customerId),
      env.DB.prepare(
        `INSERT INTO conversation_assignees (
          conversation_id, office_id, user_id, assigned_at, assigned_by
        )
        VALUES (?, ?, ?, ?, ?)`,
      ).bind(conversationId, officeId, userId, NOW, userId),
    ])

    const results = await executeBatch(env.DB, [
      env.DB.prepare(
        `INSERT INTO conversation_assignees (
          conversation_id, office_id, user_id, assigned_at, assigned_by
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, user_id) DO NOTHING`,
      ).bind(
        conversationId,
        officeId,
        userId,
        attemptedAssignedAt,
        userId,
      ),
      ...publish(env.DB, event(officeId, 'assignee-retry'), {
        query: `SELECT 1
                FROM conversation_assignees
                WHERE conversation_id = ?
                  AND user_id = ?
                  AND assigned_at = ?`,
        bindings: [conversationId, userId, attemptedAssignedAt],
      }),
    ])

    expect(changes(results[0])).toBe(0)
    await expectNoPublishedEvent(officeId)
  })

  it('skips an event when an unauthorized note update changes no rows', async () => {
    const officeId = 'office-guard-note'
    const authorId = 'user-guard-note-author'
    const otherUserId = 'user-guard-note-other'
    const customerId = 'customer-guard-note'
    const conversationId = 'conversation-guard-note'
    const noteId = 'note-guard-note'
    const attemptedBody = "권한 없음' OR 1 = 1 --"
    const attemptedUpdatedAt = NOW + 1

    await executeBatch(env.DB, [
      insertOffice(officeId),
      insertUser(authorId, officeId),
      insertUser(otherUserId, officeId),
      insertCustomer(customerId, officeId),
      insertConversation(conversationId, officeId, customerId),
      env.DB.prepare(
        `INSERT INTO notes (
          id, office_id, conversation_id, author_id, body, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        noteId,
        officeId,
        conversationId,
        authorId,
        '원래 메모',
        NOW,
        NOW,
      ),
    ])

    const results = await executeBatch(env.DB, [
      env.DB.prepare(
        `UPDATE notes
         SET body = ?, updated_at = ?
         WHERE id = ? AND author_id = ?`,
      ).bind(attemptedBody, attemptedUpdatedAt, noteId, otherUserId),
      ...publish(env.DB, event(officeId, noteId), {
        query: `SELECT 1
                FROM notes
                WHERE id = ?
                  AND author_id = ?
                  AND body = ?
                  AND updated_at = ?`,
        bindings: [noteId, otherUserId, attemptedBody, attemptedUpdatedAt],
      }),
    ])

    expect(changes(results[0])).toBe(0)
    await expectNoPublishedEvent(officeId)
  })

  it('skips an event when a stale version update changes no rows', async () => {
    const officeId = 'office-guard-version'
    const customerId = 'customer-guard-version'
    const attemptedName = '오래된 요청의 고객명'
    const attemptedUpdatedAt = NOW + 2

    await executeBatch(env.DB, [
      insertOffice(officeId),
      insertCustomer(customerId, officeId),
      env.DB.prepare(
        `UPDATE customers
         SET name = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      ).bind('먼저 반영된 고객명', NOW + 1, customerId, 1),
    ])

    const results = await executeBatch(env.DB, [
      env.DB.prepare(
        `UPDATE customers
         SET name = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      ).bind(attemptedName, attemptedUpdatedAt, customerId, 1),
      ...publish(env.DB, event(officeId, customerId), {
        query: `SELECT 1
                FROM customers
                WHERE id = ?
                  AND name = ?
                  AND version = ?
                  AND updated_at = ?`,
        bindings: [customerId, attemptedName, 2, attemptedUpdatedAt],
      }),
    ])

    expect(changes(results[0])).toBe(0)
    await expectNoPublishedEvent(officeId)
  })

  it('publishes true guards with contiguous office sequences', async () => {
    const officeId = 'office-guard-true'
    await insertOffice(officeId).run()
    const guard = {
      query: 'SELECT 1 FROM offices WHERE id = ? AND name = ?',
      bindings: [officeId, OFFICE_NAME],
    }

    await executeBatch(env.DB, [
      ...publish(env.DB, event(officeId, 'guarded-message-1'), guard),
      ...publish(env.DB, event(officeId, 'guarded-message-2'), guard),
      ...publish(env.DB, event(officeId, 'guarded-message-3'), guard),
    ])

    const { results: storedEvents } = await env.DB.prepare(
      `SELECT office_seq
       FROM events
       WHERE office_id = ?
       ORDER BY office_seq`,
    )
      .bind(officeId)
      .all<{ office_seq: number }>()
    const office = await env.DB.prepare(
      'SELECT event_seq FROM offices WHERE id = ?',
    )
      .bind(officeId)
      .first<{ event_seq: number }>()

    expect(storedEvents).toEqual([
      { office_seq: 1 },
      { office_seq: 2 },
      { office_seq: 3 },
    ])
    expect(office?.event_seq).toBe(3)
  })
})
