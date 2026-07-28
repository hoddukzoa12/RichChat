export type EventActorKind = 'user' | 'customer' | 'system'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

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

/**
 * 도메인 변경과 같은 batch에 펼쳐 넣을 이벤트 문장들을 만든다.
 * 여기서 batch를 실행하면 원인 변경과 감사 이벤트 사이의 원자성이 깨진다.
 */
export function publish(
  db: Pick<D1Database, 'prepare'>,
  event: EventInput,
): D1PreparedStatement[] {
  const payload = JSON.stringify(event.payload)

  if (payload === undefined) {
    throw new TypeError('이벤트 payload는 JSON 값이어야 합니다.')
  }

  return [
    db
      .prepare(
        'UPDATE offices SET event_seq = event_seq + 1 WHERE id = ?',
      )
      .bind(event.officeId),
    db
      .prepare(
        `INSERT INTO events (
          office_id, office_seq, type, entity, entity_id, conversation_id,
          actor_kind, actor_id, payload, created_at
        )
        VALUES (
          ?, (SELECT event_seq FROM offices WHERE id = ?), ?, ?, ?, ?, ?, ?, ?,
          ?
        )`,
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
      ),
  ]
}
