import {
  TASK_KINDS,
  type JsonValue,
  type TaskKind,
} from '../../shared/domain'
import type {
  CreateTaskRequest,
  Task,
  TaskResponse,
  UpdateTaskRequest,
} from '../../shared/wire/task'
import { changes } from '../db/d1'
import {
  publish,
  type EventInput,
  type EventPublishGuard,
} from '../db/events'
import { error } from '../http/error'
import type { Route } from '../http/router'
import { json } from '../http/respond'
import { requireSession } from '../http/session'
import { createId } from '../lib/ids'
import type { Clock } from '../lib/ids'
import { executeBatchAndBroadcast } from '../realtime/broadcast'

type JsonObject = Record<string, unknown>
type TaskPatchKey = keyof UpdateTaskRequest
type ParsedCreateTask = CreateTaskRequest & { sub: string }

interface TaskRow {
  id: string
  name: string
  sub: string
  kind: TaskKind
  sort_order: number
  created_by: string
  created_at: number
  updated_at: number
}

interface TaskRouteDependencies {
  id: () => string
  now: Clock
}

const DEFAULT_DEPENDENCIES: TaskRouteDependencies = {
  id: createId,
  now: Date.now,
}

const TASK_KIND_SET = new Set<string>(TASK_KINDS)
const PATCH_COLUMNS: Record<TaskPatchKey, string> = {
  name: 'name',
  sub: 'sub',
  kind: 'kind',
  sortOrder: 'sort_order',
}
const TASK_INPUT_KEYS = Object.keys(PATCH_COLUMNS) as TaskPatchKey[]
const TASK_EVENT_TYPES = {
  create: 'task.created',
  update: 'task.updated',
  delete: 'task.deleted',
} as const
type TaskEventAction = keyof typeof TASK_EVENT_TYPES

const TASK_ENTITY = 'task'
const TASK_COLLECTION_PATH = '/api/conversations/:id/tasks'
const TASK_ITEM_PATH = '/api/conversations/:id/tasks/:taskId'
const INVALID_TASK_MESSAGE = '업무 입력값을 확인해 주세요.'
const TASK_NOT_FOUND_MESSAGE = '요청한 업무를 찾을 수 없습니다.'

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function hasOnlyKeys(
  object: JsonObject,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys)
  return Object.keys(object).every((key) => allowed.has(key))
}

async function readJsonObject(
  request: Request,
): Promise<JsonObject | Response> {
  try {
    const value: unknown = await request.json()
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      return error('BAD_REQUEST', 'JSON 객체가 필요합니다.')
    }

    return value as JsonObject
  } catch {
    return error('BAD_REQUEST', '올바른 JSON 본문이 필요합니다.')
  }
}

function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && TASK_KIND_SET.has(value)
}

function isSortOrder(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function parseCreateTask(body: JsonObject): ParsedCreateTask | Response {
  if (
    !hasOnlyKeys(body, TASK_INPUT_KEYS) ||
    !hasOwn(body, 'name') ||
    !hasOwn(body, 'kind')
  ) {
    return error('BAD_REQUEST', '업무 이름과 상태가 필요합니다.')
  }

  if (
    typeof body.name !== 'string' ||
    body.name.trim() === '' ||
    (body.sub !== undefined && typeof body.sub !== 'string') ||
    !isTaskKind(body.kind) ||
    (body.sortOrder !== undefined && !isSortOrder(body.sortOrder))
  ) {
    return error('BAD_REQUEST', INVALID_TASK_MESSAGE)
  }

  return {
    name: body.name.trim(),
    sub: typeof body.sub === 'string' ? body.sub.trim() : '',
    kind: body.kind,
    ...(typeof body.sortOrder === 'number'
      ? { sortOrder: body.sortOrder }
      : {}),
  }
}

function parseTaskPatch(body: JsonObject): UpdateTaskRequest | Response {
  if (
    !hasOnlyKeys(body, TASK_INPUT_KEYS) ||
    Object.keys(body).length === 0
  ) {
    return error('BAD_REQUEST', '변경할 업무 값이 필요합니다.')
  }

  if (
    (body.name !== undefined &&
      (typeof body.name !== 'string' || body.name.trim() === '')) ||
    (body.sub !== undefined && typeof body.sub !== 'string') ||
    (body.kind !== undefined && !isTaskKind(body.kind)) ||
    (body.sortOrder !== undefined && !isSortOrder(body.sortOrder))
  ) {
    return error('BAD_REQUEST', INVALID_TASK_MESSAGE)
  }

  const patch: UpdateTaskRequest = {}
  if (typeof body.name === 'string') patch.name = body.name.trim()
  if (typeof body.sub === 'string') patch.sub = body.sub.trim()
  if (isTaskKind(body.kind)) patch.kind = body.kind
  if (typeof body.sortOrder === 'number') {
    patch.sortOrder = body.sortOrder
  }
  return patch
}

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    sub: row.sub,
    kind: row.kind,
    sortOrder: row.sort_order,
    createdById: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function taskEvent(
  action: TaskEventAction,
  values: {
    actorId: string
    conversationId: string
    createdAt: number
    entityId: string
    officeId: string
    payload: JsonValue
  },
): EventInput {
  return {
    officeId: values.officeId,
    type: TASK_EVENT_TYPES[action],
    entity: TASK_ENTITY,
    entityId: values.entityId,
    conversationId: values.conversationId,
    actorKind: 'user',
    actorId: values.actorId,
    payload: values.payload,
    createdAt: values.createdAt,
  }
}

function activeTaskGuard(values: {
  conversationId: string
  createdAt?: number
  expected: UpdateTaskRequest
  officeId: string
  taskId: string
  updatedAt: number
}): EventPublishGuard {
  const conditions = [
    'id = ?',
    'conversation_id = ?',
    'office_id = ?',
    'updated_at = ?',
    'deleted_at IS NULL',
  ]
  const bindings: unknown[] = [
    values.taskId,
    values.conversationId,
    values.officeId,
    values.updatedAt,
  ]

  if (values.createdAt !== undefined) {
    conditions.push('created_at = ?')
    bindings.push(values.createdAt)
  }

  for (const key of TASK_INPUT_KEYS) {
    const expected = values.expected[key]
    if (expected === undefined) continue

    conditions.push(`${PATCH_COLUMNS[key]} = ?`)
    bindings.push(expected)
  }

  return {
    query: `SELECT 1
            FROM tasks
            WHERE ${conditions.join('\n              AND ')}`,
    bindings,
  }
}

function deletedTaskGuard(values: {
  conversationId: string
  deletedAt: number
  officeId: string
  taskId: string
}): EventPublishGuard {
  return {
    query: `SELECT 1
            FROM tasks
            WHERE id = ?
              AND conversation_id = ?
              AND office_id = ?
              AND deleted_at = ?
              AND NOT EXISTS (
                SELECT 1
                FROM events
                WHERE office_id = ?
                  AND type = ?
                  AND entity = ?
                  AND entity_id = tasks.id
              )`,
    bindings: [
      values.taskId,
      values.conversationId,
      values.officeId,
      values.deletedAt,
      values.officeId,
      TASK_EVENT_TYPES.delete,
      TASK_ENTITY,
    ],
  }
}

async function createTask(
  request: Request,
  env: Env,
  conversationId: string,
  dependencies: TaskRouteDependencies,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  const input = parseCreateTask(body)
  if (input instanceof Response) return input

  const id = dependencies.id()
  const now = dependencies.now()
  const requestedSortOrder = input.sortOrder ?? null
  const mutation = env.DB.prepare(
    `INSERT INTO tasks (
      id, office_id, conversation_id, name, sub, kind, sort_order,
      created_by, created_at, updated_at
    )
    SELECT
      ?, conversations.office_id, conversations.id, ?, ?, ?,
      COALESCE(
        ?,
        (
          SELECT COALESCE(MAX(active.sort_order), -1) + 1
          FROM tasks AS active
          WHERE active.conversation_id = conversations.id
            AND active.deleted_at IS NULL
        )
      ),
      ?, ?, ?
    FROM conversations
    WHERE conversations.id = ?
      AND conversations.office_id = ?
    RETURNING
      id, name, sub, kind, sort_order, created_by, created_at, updated_at`,
  ).bind(
    id,
    input.name,
    input.sub,
    input.kind,
    requestedSortOrder,
    session.userId,
    now,
    now,
    conversationId,
    session.officeId,
  )
  const publication = publish(
    env.DB,
    taskEvent('create', {
      actorId: session.userId,
      conversationId,
      createdAt: now,
      entityId: id,
      officeId: session.officeId,
      payload: {
        name: input.name,
        sub: input.sub,
        kind: input.kind,
        sortOrder: requestedSortOrder,
      },
    }),
    activeTaskGuard({
      conversationId,
      createdAt: now,
      expected: {
        name: input.name,
        sub: input.sub,
        kind: input.kind,
        ...(input.sortOrder === undefined
          ? {}
          : { sortOrder: input.sortOrder }),
      },
      officeId: session.officeId,
      taskId: id,
      updatedAt: now,
    }),
  )
  const statements = [mutation, ...publication]
  const [result] = await executeBatchAndBroadcast<TaskRow>(
    env.DB,
    statements,
    [publication],
    ctx,
    env,
  )
  const row = result.results[0]
  if (!row) {
    return error('NOT_FOUND', '요청한 대화를 찾을 수 없습니다.')
  }

  const response: TaskResponse = { task: taskFromRow(row) }
  return json(response, { status: 201 })
}

async function patchTask(
  request: Request,
  env: Env,
  conversationId: string,
  taskId: string,
  dependencies: TaskRouteDependencies,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  const patch = parseTaskPatch(body)
  if (patch instanceof Response) return patch

  const assignments: string[] = []
  const values: unknown[] = []
  for (const key of TASK_INPUT_KEYS) {
    const value = patch[key]
    if (value === undefined) continue

    const column = PATCH_COLUMNS[key]
    assignments.push(`${column} = ?`)
    values.push(value)
  }

  const now = dependencies.now()
  const mutation = env.DB.prepare(
    `UPDATE tasks
    SET ${assignments.join(', ')}, updated_at = ?
    WHERE id = ?
      AND conversation_id = ?
      AND office_id = ?
      AND deleted_at IS NULL
    RETURNING
      id, name, sub, kind, sort_order, created_by, created_at, updated_at`,
  ).bind(
    ...values,
    now,
    taskId,
    conversationId,
    session.officeId,
  )
  const eventPatch: { [key: string]: JsonValue } = {}
  for (const key of TASK_INPUT_KEYS) {
    const value = patch[key]
    if (value !== undefined) eventPatch[key] = value
  }
  const publication = publish(
    env.DB,
    taskEvent('update', {
      actorId: session.userId,
      conversationId,
      createdAt: now,
      entityId: taskId,
      officeId: session.officeId,
      payload: eventPatch,
    }),
    activeTaskGuard({
      conversationId,
      expected: patch,
      officeId: session.officeId,
      taskId,
      updatedAt: now,
    }),
  )
  const statements = [mutation, ...publication]
  const [result] = await executeBatchAndBroadcast<TaskRow>(
    env.DB,
    statements,
    [publication],
    ctx,
    env,
  )
  const row = result.results[0]
  if (!row) {
    return error('NOT_FOUND', TASK_NOT_FOUND_MESSAGE)
  }

  const response: TaskResponse = { task: taskFromRow(row) }
  return json(response)
}

async function deleteTask(
  request: Request,
  env: Env,
  conversationId: string,
  taskId: string,
  dependencies: TaskRouteDependencies,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const now = dependencies.now()
  const mutation = env.DB
    .prepare(
      `UPDATE tasks
      SET deleted_at = ?, updated_at = ?
      WHERE id = ?
        AND conversation_id = ?
        AND office_id = ?
        AND deleted_at IS NULL`,
    )
    .bind(
      now,
      now,
      taskId,
      conversationId,
      session.officeId,
    )
  const publication = publish(
    env.DB,
    taskEvent('delete', {
      actorId: session.userId,
      conversationId,
      createdAt: now,
      entityId: taskId,
      officeId: session.officeId,
      payload: { deletedAt: now },
    }),
    deletedTaskGuard({
      conversationId,
      deletedAt: now,
      officeId: session.officeId,
      taskId,
    }),
  )
  const statements = [mutation, ...publication]
  const [result] = await executeBatchAndBroadcast(
    env.DB,
    statements,
    [publication],
    ctx,
    env,
  )
  if (changes(result) === 0) {
    return error('NOT_FOUND', TASK_NOT_FOUND_MESSAGE)
  }

  return new Response(null, { status: 204 })
}

export function createTaskRoutes(
  dependencies: TaskRouteDependencies = DEFAULT_DEPENDENCIES,
): Route[] {
  return [
    {
      method: 'POST',
      path: TASK_COLLECTION_PATH,
      handler: (request, env, params, ctx) =>
        createTask(request, env, params.id, dependencies, ctx),
    },
    {
      method: 'PATCH',
      path: TASK_ITEM_PATH,
      handler: (request, env, params, ctx) =>
        patchTask(
          request,
          env,
          params.id,
          params.taskId,
          dependencies,
          ctx,
        ),
    },
    {
      method: 'DELETE',
      path: TASK_ITEM_PATH,
      handler: (request, env, params, ctx) =>
        deleteTask(
          request,
          env,
          params.id,
          params.taskId,
          dependencies,
          ctx,
        ),
    },
  ]
}

export const routes = createTaskRoutes()
