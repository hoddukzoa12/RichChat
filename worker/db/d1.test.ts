import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { changes, D1BatchError, executeBatch } from './d1'
import { publish, type EventInput } from './events'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const NOW = 1_753_670_800_123

function insertOffice(id: string): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
  ).bind(id, '리치 세무법인', NOW)
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
})
