export const EVENT_ACTOR_KINDS = [
  'user',
  'customer',
  'system',
] as const

export type EventActorKind = (typeof EVENT_ACTOR_KINDS)[number]

export type EventPayload =
  | null
  | boolean
  | number
  | string
  | EventPayload[]
  | { [key: string]: EventPayload }

/**
 * HTTP 캐치업 행과 실시간 프레임이 함께 쓰는 이벤트 봉투다.
 * 전역 seq는 사무소별 연속성 판정에 쓸 수 없으므로 노출하지 않는다.
 */
export interface EventEnvelope {
  officeSeq: number
  type: string
  entity: string
  entityId: string
  conversationId: string | null
  actorKind: EventActorKind
  actorId: string | null
  payload: EventPayload
  createdAt: number
}

export interface EventCatchupResponse {
  events: EventEnvelope[]
  hasMore: boolean
  nextCursor: number
}
