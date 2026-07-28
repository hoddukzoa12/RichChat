import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  TASK_KINDS,
  type TaskKind,
} from '../../shared/domain'
import type {
  Task,
  TaskResponse,
} from '../../shared/wire/task'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import { createTaskRoutes } from './tasks'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

interface Fixture {
  conversationId: string
  officeId: string
  otherConversationId: string
  token: string
  otherToken: string
  userId: string
  otherUserId: string
}

interface StoredTask {
  id: string
  name: string
  sub: string
  kind: TaskKind
  sort_order: number
  created_by: string
  deleted_at: number | null
}

let fixtureSequence = 0

async function seedFixture(status = '처리중'): Promise<Fixture> {
  fixtureSequence += 1
  const suffix = `tasks-${fixtureSequence}`
  const officeId = `office-${suffix}`
  const userId = `user-${suffix}-a`
  const otherUserId = `user-${suffix}-b`
  const customerId = `customer-${suffix}-a`
  const otherCustomerId = `customer-${suffix}-b`
  const conversationId = `conversation-${suffix}-a`
  const otherConversationId = `conversation-${suffix}-b`
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at, updated_at
      ) VALUES
        (?, ?, ?, ?, ?, '세무사', '활성', ?, ?),
        (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    ).bind(
      userId,
      officeId,
      `${suffix}-a@rich.example`,
      '김세무',
      '세무사',
      now,
      now,
      otherUserId,
      officeId,
      `${suffix}-b@rich.example`,
      '박상담',
      '상담 담당',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES
        (?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      `+8210${String(fixtureSequence).padStart(8, '0')}`,
      '가 고객',
      now,
      now,
      otherCustomerId,
      officeId,
      `+8211${String(fixtureSequence).padStart(8, '0')}`,
      '나 고객',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, status, created_at, updated_at
      ) VALUES
        (?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?)`,
    ).bind(
      conversationId,
      officeId,
      customerId,
      status,
      now,
      now,
      otherConversationId,
      officeId,
      otherCustomerId,
      '미처리',
      now,
      now,
    ),
  ])

  const session = await createSession(env.DB, { userId, officeId }, now)
  const otherSession = await createSession(
    env.DB,
    { userId: otherUserId, officeId },
    now,
  )

  return {
    conversationId,
    officeId,
    otherConversationId,
    token: session.token,
    otherToken: otherSession.token,
    userId,
    otherUserId,
  }
}

function taskPath(conversationId: string, taskId?: string): string {
  const collection = `/api/conversations/${conversationId}/tasks`
  return taskId === undefined ? collection : `${collection}/${taskId}`
}

async function request(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  values: {
    body?: Record<string, unknown>
    token?: string
  } = {},
): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN })
  if (values.token) {
    headers.set(
      'cookie',
      `${SESSION_COOKIE_NAME}=${values.token}`,
    )
  }
  if (values.body) headers.set('content-type', 'application/json')

  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: values.body ? JSON.stringify(values.body) : undefined,
  })
}

async function taskResponse(response: Response): Promise<Task> {
  const body = (await response.json()) as TaskResponse
  return body.task
}

async function createTask(
  fixture: Fixture,
  values: {
    kind?: TaskKind
    name?: string
    sortOrder?: number
    sub?: string
    token?: string
  } = {},
): Promise<Task> {
  const response = await request(
    'POST',
    taskPath(fixture.conversationId),
    {
      token: values.token ?? fixture.token,
      body: {
        name: values.name ?? '1기 부가세 신고',
        sub: values.sub ?? '기한 7/31',
        kind: values.kind ?? 'idle',
        ...(values.sortOrder === undefined
          ? {}
          : { sortOrder: values.sortOrder }),
      },
    },
  )
  expect(response.status).toBe(201)
  return taskResponse(response)
}

async function storedTasks(
  conversationId: string,
  includeDeleted = false,
): Promise<StoredTask[]> {
  const { results } = await env.DB.prepare(
    `SELECT
      id, name, sub, kind, sort_order, created_by, deleted_at
    FROM tasks
    WHERE conversation_id = ?
      ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    ORDER BY sort_order, id`,
  )
    .bind(conversationId)
    .all<StoredTask>()
  return results
}

async function eventCount(officeId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
    FROM events
    WHERE office_id = ?`,
  )
    .bind(officeId)
    .first<{ count: number }>()
  return row?.count ?? 0
}

async function expectEventState(
  officeId: string,
  expected: number,
): Promise<void> {
  const office = await env.DB.prepare(
    'SELECT event_seq FROM offices WHERE id = ?',
  )
    .bind(officeId)
    .first<{ event_seq: number }>()

  expect(await eventCount(officeId)).toBe(expected)
  expect(office?.event_seq).toBe(expected)
}

describe('Task routes', () => {
  it.each([
    {
      method: 'POST' as const,
      path: '/api/conversations/missing/tasks',
      body: { name: '업무', kind: 'idle' },
    },
    {
      method: 'PATCH' as const,
      path: '/api/conversations/missing/tasks/missing',
      body: { kind: 'done' },
    },
    {
      method: 'DELETE' as const,
      path: '/api/conversations/missing/tasks/missing',
    },
  ])('rejects $method without a session cookie', async (example) => {
    const response = await request(example.method, example.path, {
      body: example.body,
    })

    expect(response.status).toBe(401)
  })

  it.each(TASK_KINDS)(
    'round-trips the %s kind without mapping',
    async (kind) => {
      const fixture = await seedFixture()
      const created = await createTask(fixture, { kind })
      expect(created.kind).toBe(kind)

      const [read] = await storedTasks(fixture.conversationId)
      expect(read.kind).toBe(kind)

      const response = await request(
        'PATCH',
        taskPath(fixture.conversationId, read.id),
        {
          token: fixture.token,
          body: {
            name: read.name,
            sub: read.sub,
            kind: read.kind,
            sortOrder: read.sort_order,
          },
        },
      )

      expect(response.status).toBe(200)
      await expect(taskResponse(response)).resolves.toMatchObject({
        id: read.id,
        kind,
      })
      const [stored] = await storedTasks(fixture.conversationId)
      expect(stored.kind).toBe(kind)
      expect(await eventCount(fixture.officeId)).toBe(2)
    },
  )

  it('rejects an unsupported kind before the database', async () => {
    const fixture = await seedFixture()
    const createResponse = await request(
      'POST',
      taskPath(fixture.conversationId),
      {
        token: fixture.token,
        body: { name: '잘못된 업무', kind: 'complete' },
      },
    )
    expect(createResponse.status).toBe(400)

    const task = await createTask(fixture)
    const patchResponse = await request(
      'PATCH',
      taskPath(fixture.conversationId, task.id),
      {
        token: fixture.token,
        body: { kind: 'complete' },
      },
    )
    expect(patchResponse.status).toBe(400)

    const [stored] = await storedTasks(fixture.conversationId)
    expect(stored.kind).toBe('idle')
    expect(await eventCount(fixture.officeId)).toBe(1)
  })

  it('uses IDs after deleting the middle task and preserves rows', async () => {
    const fixture = await seedFixture('처리중')
    const first = await createTask(fixture, {
      name: '첫 업무',
      sortOrder: 0,
    })
    const middle = await createTask(fixture, {
      name: '가운데 업무',
      sortOrder: 1,
    })
    const last = await createTask(fixture, {
      name: '마지막 업무',
      sortOrder: 2,
    })

    const deleted = await request(
      'DELETE',
      taskPath(fixture.conversationId, middle.id),
      { token: fixture.token },
    )
    expect(deleted.status).toBe(204)

    const lastUpdate = await request(
      'PATCH',
      taskPath(fixture.conversationId, last.id),
      {
        token: fixture.token,
        body: { name: '마지막 업무 수정', kind: 'done' },
      },
    )
    expect(lastUpdate.status).toBe(200)
    const firstUpdate = await request(
      'PATCH',
      taskPath(fixture.conversationId, first.id),
      {
        token: fixture.token,
        body: { sortOrder: 3 },
      },
    )
    expect(firstUpdate.status).toBe(200)

    const active = await storedTasks(fixture.conversationId)
    expect(active).toEqual([
      expect.objectContaining({
        id: last.id,
        name: '마지막 업무 수정',
        kind: 'done',
        sort_order: 2,
      }),
      expect.objectContaining({
        id: first.id,
        name: '첫 업무',
        sort_order: 3,
      }),
    ])

    const all = await storedTasks(fixture.conversationId, true)
    const deletedRow = all.find(({ id }) => id === middle.id)
    expect(deletedRow?.deleted_at).toEqual(expect.any(Number))

    const conversation = await env.DB.prepare(
      'SELECT status FROM conversations WHERE id = ?',
    )
      .bind(fixture.conversationId)
      .first<{ status: string }>()
    expect(conversation?.status).toBe('처리중')
    expect(await eventCount(fixture.officeId)).toBe(6)
  })

  it('does not publish a second event for a repeated delete', async () => {
    const fixture = await seedFixture()
    const task = await createTask(fixture)
    const deletedAt = Date.now() + 1
    const deleteRoute = createTaskRoutes({
      id: () => 'unused-id',
      now: () => deletedAt,
    }).find(({ method }) => method === 'DELETE')
    expect(deleteRoute).toBeDefined()

    const deleteOnce = () =>
      deleteRoute?.handler(
        new Request(
          `${ORIGIN}${taskPath(fixture.conversationId, task.id)}`,
          {
            method: 'DELETE',
            headers: {
              cookie: `${SESSION_COOKIE_NAME}=${fixture.token}`,
              origin: ORIGIN,
            },
          },
        ),
        env,
        { id: fixture.conversationId, taskId: task.id },
      )

    const first = await deleteOnce()
    expect(first?.status).toBe(204)
    await expectEventState(fixture.officeId, 2)
    const [afterFirst] = await storedTasks(
      fixture.conversationId,
      true,
    )

    const second = await deleteOnce()
    expect(second?.status).toBe(404)
    await expectEventState(fixture.officeId, 2)

    const [stored] = await storedTasks(fixture.conversationId, true)
    expect(stored.id).toBe(task.id)
    expect(stored.deleted_at).toBe(afterFirst.deleted_at)
  })

  it('scopes mutation by the conversation path', async () => {
    const fixture = await seedFixture()
    const task = await createTask(fixture, {
      name: '첫 대화 업무',
      kind: 'warn',
    })

    const patchResponse = await request(
      'PATCH',
      taskPath(fixture.otherConversationId, task.id),
      {
        token: fixture.token,
        body: { name: '다른 대화에서 수정', kind: 'done' },
      },
    )
    expect(patchResponse.status).toBe(404)

    const deleteResponse = await request(
      'DELETE',
      taskPath(fixture.otherConversationId, task.id),
      { token: fixture.token },
    )
    expect(deleteResponse.status).toBe(404)

    const [stored] = await storedTasks(fixture.conversationId, true)
    expect(stored).toMatchObject({
      id: task.id,
      name: '첫 대화 업무',
      kind: 'warn',
      deleted_at: null,
    })
    await expectEventState(fixture.officeId, 1)
  })

  it('allows a staff member other than the creator to update a task', async () => {
    const fixture = await seedFixture()
    const task = await createTask(fixture, {
      name: '인수인계 업무',
    })

    const response = await request(
      'PATCH',
      taskPath(fixture.conversationId, task.id),
      {
        token: fixture.otherToken,
        body: { name: '인수인계 완료', kind: 'done' },
      },
    )
    expect(response.status).toBe(200)
    await expect(taskResponse(response)).resolves.toMatchObject({
      id: task.id,
      name: '인수인계 완료',
      kind: 'done',
    })

    const [stored] = await storedTasks(fixture.conversationId)
    expect(stored.created_by).toBe(fixture.userId)
    const { results: events } = await env.DB.prepare(
      `SELECT actor_id
      FROM events
      WHERE office_id = ?
        AND entity_id = ?
      ORDER BY office_seq`,
    )
      .bind(fixture.officeId, task.id)
      .all<{ actor_id: string }>()
    expect(events).toEqual([
      { actor_id: fixture.userId },
      { actor_id: fixture.otherUserId },
    ])
  })

  it('emits one event for each successful mutation', async () => {
    const fixture = await seedFixture()
    const task = await createTask(fixture)
    expect(await eventCount(fixture.officeId)).toBe(1)

    const changed = await request(
      'PATCH',
      taskPath(fixture.conversationId, task.id),
      {
        token: fixture.token,
        body: { kind: 'done' },
      },
    )
    expect(changed.status).toBe(200)
    expect(await eventCount(fixture.officeId)).toBe(2)

    const noOp = await request(
      'PATCH',
      taskPath(fixture.conversationId, task.id),
      {
        token: fixture.token,
        body: { kind: 'done' },
      },
    )
    expect(noOp.status).toBe(200)
    expect(await eventCount(fixture.officeId)).toBe(3)

    const deleted = await request(
      'DELETE',
      taskPath(fixture.conversationId, task.id),
      { token: fixture.token },
    )
    expect(deleted.status).toBe(204)
    expect(await eventCount(fixture.officeId)).toBe(4)
  })

  it('does not expose or store a badge field', async () => {
    const fixture = await seedFixture()
    const task = await createTask(fixture, { kind: 'done' })

    expect(Object.keys(task).sort()).toEqual([
      'createdAt',
      'createdById',
      'id',
      'kind',
      'name',
      'sortOrder',
      'sub',
      'updatedAt',
    ])
    const { results: columns } = await env.DB.prepare(
      `SELECT name
      FROM pragma_table_info('tasks')
      ORDER BY cid`,
    ).all<{ name: string }>()
    expect(columns.map(({ name }) => name)).not.toContain('badge')
  })
})
