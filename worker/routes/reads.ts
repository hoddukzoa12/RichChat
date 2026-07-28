import { changes } from '../db/d1'
import { publish } from '../db/events'
import { error } from '../http/error'
import type { Route } from '../http/router'
import { requireSession } from '../http/session'
import type { Clock } from '../lib/ids'
import { executeBatchAndBroadcast } from '../realtime/broadcast'

const READ_EVENT_TYPE = 'conversation.read'
const READ_ENTITY = 'conversation'

interface ConversationCountRow {
  inbound_count: number
}

type JsonObject = Record<string, unknown>

async function readInboundCount(
  request: Request,
): Promise<number | Response> {
  let value: unknown

  try {
    value = await request.json()
  } catch {
    return error('BAD_REQUEST', '올바른 JSON 본문이 필요합니다.')
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return error('BAD_REQUEST', 'JSON 객체가 필요합니다.')
  }

  const count = (value as JsonObject).readInboundCount
  if (
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    return error(
      'BAD_REQUEST',
      '읽은 수신 메시지 수는 0 이상의 정수여야 합니다.',
    )
  }

  return count
}

export function createReadRoutes(clock: Clock = Date.now): Route[] {
  return [
    {
      method: 'POST',
      path: '/api/conversations/:id/read',
      async handler(request, env, params, ctx): Promise<Response> {
        const session = await requireSession(request, env)
        if (session instanceof Response) return session

        const requestedCount = await readInboundCount(request)
        if (requestedCount instanceof Response) return requestedCount

        const conversation = await env.DB.prepare(
          `SELECT inbound_count
           FROM conversations
           WHERE id = ?
             AND office_id = ?`,
        )
          .bind(params.id, session.officeId)
          .first<ConversationCountRow>()
        if (!conversation) {
          return error('NOT_FOUND', '대화를 찾을 수 없습니다.')
        }

        const nextCount = Math.min(
          requestedCount,
          conversation.inbound_count,
        )
        const updatedAt = clock()
        const publication = publish(
          env.DB,
          {
            officeId: session.officeId,
            type: READ_EVENT_TYPE,
            entity: READ_ENTITY,
            entityId: params.id,
            conversationId: params.id,
            actorKind: 'user',
            actorId: session.userId,
            payload: { readInboundCount: nextCount },
            createdAt: updatedAt,
          },
          {
            query: `SELECT 1
                    FROM conversations
                    WHERE id = ?
                      AND office_id = ?
                      AND COALESCE((
                        SELECT read_inbound_count
                        FROM conversation_reads
                        WHERE conversation_id = ?
                          AND user_id = ?
                      ), 0) < ?`,
            bindings: [
              params.id,
              session.officeId,
              params.id,
              session.userId,
              nextCount,
            ],
          },
        )
        const mutation = env.DB.prepare(
          `INSERT INTO conversation_reads (
             conversation_id,
             office_id,
             user_id,
             read_inbound_count,
             updated_at
           )
           SELECT id, office_id, ?, ?, ?
           FROM conversations
           WHERE id = ?
             AND office_id = ?
           ON CONFLICT(conversation_id, user_id)
           DO UPDATE SET
             read_inbound_count = MAX(
               excluded.read_inbound_count,
               conversation_reads.read_inbound_count
             ),
             updated_at = ?`,
        ).bind(
          session.userId,
          nextCount,
          updatedAt,
          params.id,
          session.officeId,
          updatedAt,
        )
        const statements = [
          ...publication,
          mutation,
        ]
        const results = await executeBatchAndBroadcast(
          env.DB,
          statements,
          [publication],
          ctx,
          env,
        )
        const mutationResult = results[publication.length]

        if (!mutationResult) {
          throw new TypeError('읽음 커서 문장의 실행 결과가 없습니다.')
        }
        if (changes(mutationResult) === 0) {
          return error('NOT_FOUND', '대화를 찾을 수 없습니다.')
        }

        return new Response(null, { status: 204 })
      },
    },
  ]
}

export const routes = createReadRoutes()
