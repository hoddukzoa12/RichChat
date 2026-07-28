import type { EventActorKind, JsonValue } from '../../shared/domain'
import type { EventEnvelope } from '../../shared/wire/event'

export interface EventInput {
  officeId: string
  type: string
  entity: string
  entityId: string
  conversationId?: string | null
  actorKind: EventActorKind
  actorId?: string | null
  payload: JsonValue
  createdAt: number
}

export interface EventPublishGuard {
  /**
   * 변경 결과가 존재할 때 행을 반환하는 SELECT 문이다.
   * 사용자 입력은 문자열에 보간하지 말고 bindings로만 전달한다.
   */
  query: string
  bindings?: readonly unknown[]
}

export interface EventRow {
  office_seq: number
  type: string
  entity: string
  entity_id: string
  conversation_id: string | null
  actor_kind: EventActorKind
  actor_id: string | null
  payload: string
  created_at: number
}

export interface PublishedEventRow extends EventRow {
  office_id: string
}

export type EventPublication = readonly [
  D1PreparedStatement,
  D1PreparedStatement,
]

export function eventEnvelope(row: EventRow): EventEnvelope {
  return {
    officeSeq: row.office_seq,
    type: row.type,
    entity: row.entity,
    entityId: row.entity_id,
    conversationId: row.conversation_id,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    payload: JSON.parse(row.payload) as JsonValue,
    createdAt: row.created_at,
  }
}

/**
 * 도메인 변경과 같은 batch에 펼쳐 넣을 이벤트 문장들을 만든다.
 * 여기서 batch를 실행하면 원인 변경과 감사 이벤트 사이의 원자성이 깨진다.
 */
export function publish(
  db: Pick<D1Database, 'prepare'>,
  event: EventInput,
  guard?: EventPublishGuard,
): EventPublication {
  const payload = JSON.stringify(event.payload)

  if (payload === undefined) {
    throw new TypeError('이벤트 payload는 JSON 값이어야 합니다.')
  }

  const guardCondition = guard ? `EXISTS (${guard.query})` : null
  const updateGuard = guardCondition ? ` AND ${guardCondition}` : ''
  const insertGuard = guardCondition ? ` WHERE ${guardCondition}` : ''
  const guardBindings = guard?.bindings ?? []

  return [
    db
      .prepare(
        `UPDATE offices
         SET event_seq = event_seq + 1
         WHERE id = ?${updateGuard}`,
      )
      .bind(event.officeId, ...guardBindings),
    db
      .prepare(
        `INSERT INTO events (
          office_id, office_seq, type, entity, entity_id, conversation_id,
          actor_kind, actor_id, payload, created_at
        )
        SELECT
          ?, (SELECT event_seq FROM offices WHERE id = ?), ?, ?, ?, ?, ?, ?, ?,
          ?
        ${insertGuard}
        RETURNING
          office_id,
          office_seq,
          type,
          entity,
          entity_id,
          conversation_id,
          actor_kind,
          actor_id,
          payload,
          created_at`,
      )
      .bind(
        event.officeId,
        event.officeId,
        event.type,
        event.entity,
        event.entityId,
        event.conversationId ?? null,
        event.actorKind,
        event.actorId ?? null,
        payload,
        event.createdAt,
        ...guardBindings,
      ),
  ] as const
}
