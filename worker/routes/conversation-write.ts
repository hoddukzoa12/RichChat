import {
  STATUSES,
  type JsonValue,
  type Status,
} from '../../shared/domain'
import type {
  ConversationWriteResponse,
  ConversationWriteState,
} from '../../shared/wire/conversation'
import type { ApiError } from '../../shared/wire/error'
import { changes } from '../db/d1'
import {
  publish,
  type EventInput,
  type EventPublishGuard,
} from '../db/events'
import { error, ERROR_STATUS } from '../http/error'
import { json } from '../http/respond'
import type { Route } from '../http/router'
import { executeBatchAndBroadcast } from '../realtime/broadcast'
import {
  requireSession,
  type SessionContext,
} from '../http/session'

const PATCH_VALUE_KEYS = ['status', 'archived', 'label'] as const
const PATCH_KEYS = [...PATCH_VALUE_KEYS, 'version'] as const
const CONVERSATION_VERSION_PREDICATE = `id = ?
  AND office_id = ?
  AND version = ?`
const ASSIGNEE_PREDICATE = `conversation_id = ?
  AND office_id = ?
  AND user_id = ?`

interface ConversationRow {
  id: string
  status: Status
  label: string
  archived_at: number | null
  version: number
  updated_at: number
}

interface ConversationPatch {
  status?: Status
  archived?: boolean
  label?: string
  version: number
}

type JsonObject = Record<string, unknown>

/**
 * 가드가 참인 변경만 이벤트를 먼저 쓰고, 실제 변경을 같은 batch 마지막에 둔다.
 * 가드와 변경 조건이 같으므로 batch 안에서 다른 쓰기가 끼어들지 않으며,
 * 마지막 문장이 실패하면 앞선 이벤트도 함께 롤백된다.
 */
async function executeGuardedMutation(
  env: Env,
  ctx: ExecutionContext | undefined,
  event: EventInput,
  guard: EventPublishGuard,
  mutation: D1PreparedStatement,
): Promise<D1Result> {
  const publication = publish(env.DB, event, guard)
  const statements = [...publication, mutation]
  const results = await executeBatchAndBroadcast(
    env.DB,
    statements,
    [publication],
    ctx,
    env,
  )
  const mutationResult = results[publication.length]

  if (!mutationResult) {
    throw new TypeError('변경 문장의 실행 결과가 없습니다.')
  }

  return mutationResult
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

function parsePatch(body: JsonObject): ConversationPatch | Response {
  const allowedKeys = new Set<string>(PATCH_KEYS)
  if (
    !Object.keys(body).every((key) => allowedKeys.has(key)) ||
    !PATCH_VALUE_KEYS.some((key) => Object.hasOwn(body, key))
  ) {
    return error('BAD_REQUEST', '변경할 대화 값이 필요합니다.')
  }

  if (
    !Number.isSafeInteger(body.version) ||
    (body.version as number) < 1
  ) {
    return error('BAD_REQUEST', '올바른 대화 버전이 필요합니다.')
  }

  if (
    body.status !== undefined &&
    (typeof body.status !== 'string' ||
      !STATUSES.includes(body.status as Status))
  ) {
    return error('BAD_REQUEST', '대화 상태가 올바르지 않습니다.')
  }

  if (
    body.archived !== undefined &&
    typeof body.archived !== 'boolean'
  ) {
    return error('BAD_REQUEST', '보관 여부는 참 또는 거짓이어야 합니다.')
  }

  if (body.label !== undefined && typeof body.label !== 'string') {
    return error('BAD_REQUEST', '라벨은 문자열이어야 합니다.')
  }

  return {
    version: body.version as number,
    ...(body.status === undefined
      ? {}
      : { status: body.status as Status }),
    ...(body.archived === undefined
      ? {}
      : { archived: body.archived }),
    ...(body.label === undefined ? {} : { label: body.label }),
  }
}

async function loadConversation(
  env: Env,
  session: SessionContext,
  conversationId: string,
): Promise<ConversationRow | null> {
  return env.DB.prepare(
    `SELECT id, status, label, archived_at, version, updated_at
     FROM conversations
     WHERE id = ?
       AND office_id = ?`,
  )
    .bind(conversationId, session.officeId)
    .first<ConversationRow>()
}

function writeState(row: ConversationRow): ConversationWriteState {
  return {
    id: row.id,
    status: row.status,
    label: row.label,
    archived: row.archived_at !== null,
    version: row.version,
    updatedAt: row.updated_at,
  }
}

function versionConflict(row: ConversationRow): Response {
  return json(
    {
      error: {
        code: 'CONFLICT_VERSION',
        message: '다른 사용자가 먼저 대화를 변경했습니다.',
        detail: {
          conversation: writeState(row),
        },
      },
    } satisfies ApiError,
    { status: ERROR_STATUS.CONFLICT_VERSION },
  )
}

function patchPayload(
  patch: ConversationPatch,
  nextVersion: number,
): JsonValue {
  return {
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.archived === undefined
      ? {}
      : { archived: patch.archived }),
    ...(patch.label === undefined ? {} : { label: patch.label }),
    version: nextVersion,
  }
}

async function patchConversation(
  request: Request,
  env: Env,
  conversationId: string,
  now: () => number,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  const patch = parsePatch(body)
  if (patch instanceof Response) return patch

  const updatedAt = now()
  const nextVersion = patch.version + 1
  const guard = {
    query: `SELECT 1
            FROM conversations
            WHERE ${CONVERSATION_VERSION_PREDICATE}`,
    bindings: [conversationId, session.officeId, patch.version],
  }
  const mutation = env.DB.prepare(
    `UPDATE conversations
     SET status = CASE WHEN ? = 1 THEN ? ELSE status END,
         archived_at = CASE WHEN ? = 1 THEN ? ELSE archived_at END,
         label = CASE WHEN ? = 1 THEN ? ELSE label END,
         version = version + 1,
         updated_at = ?
     WHERE ${CONVERSATION_VERSION_PREDICATE}`,
  ).bind(
    Number(patch.status !== undefined),
    patch.status ?? null,
    Number(patch.archived !== undefined),
    patch.archived === true ? updatedAt : null,
    Number(patch.label !== undefined),
    patch.label ?? null,
    updatedAt,
    conversationId,
    session.officeId,
    patch.version,
  )

  const result = await executeGuardedMutation(
    env,
    ctx,
    {
      officeId: session.officeId,
      type: 'conversation.updated',
      entity: 'conversation',
      entityId: conversationId,
      conversationId,
      actorKind: 'user',
      actorId: session.userId,
      payload: patchPayload(patch, nextVersion),
      createdAt: updatedAt,
    },
    guard,
    mutation,
  )

  if (changes(result) !== 1) {
    const current = await loadConversation(env, session, conversationId)
    if (!current) {
      return error('NOT_FOUND', '대화를 찾을 수 없습니다.')
    }

    return versionConflict(current)
  }

  const updated = await loadConversation(env, session, conversationId)
  if (!updated) {
    return error('NOT_FOUND', '대화를 찾을 수 없습니다.')
  }

  return json({
    conversation: writeState(updated),
  } satisfies ConversationWriteResponse)
}

async function userExists(
  env: Env,
  session: SessionContext,
  userId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS found
     FROM users
     WHERE id = ?
       AND office_id = ?`,
  )
    .bind(userId, session.officeId)
    .first<{ found: number }>()

  return row !== null
}

function assignmentGuard(
  session: SessionContext,
  conversationId: string,
  userId: string,
) {
  return {
    query: `SELECT 1
            FROM conversations
            WHERE id = ?
              AND office_id = ?
              AND EXISTS (
                SELECT 1
                FROM users
                WHERE id = ?
                  AND office_id = ?
              )
              AND NOT EXISTS (
                SELECT 1
                FROM conversation_assignees
                WHERE ${ASSIGNEE_PREDICATE}
              )`,
    bindings: [
      conversationId,
      session.officeId,
      userId,
      session.officeId,
      conversationId,
      session.officeId,
      userId,
    ],
  }
}

async function assignConversation(
  request: Request,
  env: Env,
  conversationId: string,
  userId: string,
  now: () => number,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const assignedAt = now()
  const guard = assignmentGuard(session, conversationId, userId)
  const mutation = env.DB.prepare(
    `INSERT INTO conversation_assignees (
       conversation_id, office_id, user_id, assigned_at, assigned_by
     )
     SELECT ?, ?, ?, ?, ?
     WHERE EXISTS (${guard.query})
     ON CONFLICT(conversation_id, user_id) DO NOTHING`,
  ).bind(
    conversationId,
    session.officeId,
    userId,
    assignedAt,
    session.userId,
    ...(guard.bindings ?? []),
  )

  const result = await executeGuardedMutation(
    env,
    ctx,
    {
      officeId: session.officeId,
      type: 'conversation.assignee_assigned',
      entity: 'conversation',
      entityId: conversationId,
      conversationId,
      actorKind: 'user',
      actorId: session.userId,
      payload: { userId },
      createdAt: assignedAt,
    },
    guard,
    mutation,
  )

  if (changes(result) === 1) {
    return new Response(null, { status: 204 })
  }

  const conversation = await loadConversation(
    env,
    session,
    conversationId,
  )
  if (!conversation) {
    return error('NOT_FOUND', '대화를 찾을 수 없습니다.')
  }

  if (!(await userExists(env, session, userId))) {
    return error('NOT_FOUND', '담당자를 찾을 수 없습니다.')
  }

  return new Response(null, { status: 204 })
}

async function unassignConversation(
  request: Request,
  env: Env,
  conversationId: string,
  userId: string,
  now: () => number,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const unassignedAt = now()
  const guard = {
    query: `SELECT 1
            FROM conversation_assignees
            WHERE ${ASSIGNEE_PREDICATE}`,
    bindings: [conversationId, session.officeId, userId],
  }
  const mutation = env.DB.prepare(
    `DELETE FROM conversation_assignees
     WHERE ${ASSIGNEE_PREDICATE}`,
  ).bind(conversationId, session.officeId, userId)

  const result = await executeGuardedMutation(
    env,
    ctx,
    {
      officeId: session.officeId,
      type: 'conversation.assignee_unassigned',
      entity: 'conversation',
      entityId: conversationId,
      conversationId,
      actorKind: 'user',
      actorId: session.userId,
      payload: { userId },
      createdAt: unassignedAt,
    },
    guard,
    mutation,
  )

  if (changes(result) === 0) {
    const conversation = await loadConversation(
      env,
      session,
      conversationId,
    )
    if (!conversation) {
      return error('NOT_FOUND', '대화를 찾을 수 없습니다.')
    }
  }

  return new Response(null, { status: 204 })
}

export function createConversationWriteRoutes(
  now: () => number = Date.now,
): Route[] {
  return [
    {
      method: 'PATCH',
      path: '/api/conversations/:id',
      handler: (request, env, params, ctx) =>
        patchConversation(request, env, params.id, now, ctx),
    },
    {
      method: 'POST',
      path: '/api/conversations/:id/assignees/:userId',
      handler: (request, env, params, ctx) =>
        assignConversation(
          request,
          env,
          params.id,
          params.userId,
          now,
          ctx,
        ),
    },
    {
      method: 'DELETE',
      path: '/api/conversations/:id/assignees/:userId',
      handler: (request, env, params, ctx) =>
        unassignConversation(
          request,
          env,
          params.id,
          params.userId,
          now,
          ctx,
        ),
    },
  ]
}

export const routes = createConversationWriteRoutes()
