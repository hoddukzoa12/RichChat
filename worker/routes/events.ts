import type {
  EventActorKind,
  JsonValue,
} from '../../shared/domain'
import type {
  EventCatchupResponse,
  EventCursorGoneResponse,
  EventEnvelope,
} from '../../shared/wire/event'
import { error } from '../http/error'
import { json } from '../http/respond'
import type { Route } from '../http/router'
import { requireSession } from '../http/session'

export const EVENT_PAGE_LIMIT = 100

export const EVENTS_PAGE_SQL = `SELECT
  office_seq,
  type,
  entity,
  entity_id,
  conversation_id,
  actor_kind,
  actor_id,
  payload,
  created_at
FROM events INDEXED BY ux_events_office_seq
WHERE office_id = ?
  AND office_seq > ?
ORDER BY office_seq ASC
LIMIT ?`

const EVENT_RANGE_SQL = `SELECT
  offices.event_seq AS current_seq,
  MIN(events.office_seq) AS first_seq
FROM offices
LEFT JOIN events ON events.office_id = offices.id
WHERE offices.id = ?
GROUP BY offices.id, offices.event_seq`

const DECIMAL_CURSOR = /^(0|[1-9]\d*)$/

interface EventRangeRow {
  current_seq: number
  first_seq: number | null
}

interface EventRow {
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

function parseCursor(request: Request): number | undefined {
  const value = new URL(request.url).searchParams.get('since')
  if (value === null || !DECIMAL_CURSOR.test(value)) return undefined

  const cursor = Number(value)
  return Number.isSafeInteger(cursor) ? cursor : undefined
}

function cursorGone(currentCursor: number): Response {
  const detail: EventCursorGoneResponse['error']['detail'] = {
    currentCursor,
  }
  return error(
    'GONE',
    '이벤트 커서가 현재 데이터와 맞지 않아 전체 동기화가 필요합니다.',
    detail,
  )
}

function isContiguous(rows: readonly EventRow[], since: number): boolean {
  return rows.every(
    (row, index) => row.office_seq === since + index + 1,
  )
}

function envelope(row: EventRow): EventEnvelope {
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

async function getEvents(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const since = parseCursor(request)
  if (since === undefined) {
    return error(
      'BAD_REQUEST',
      'since는 0 이상의 안전한 정수여야 합니다.',
    )
  }

  const [rangeResult, pageResult] = await env.DB.batch<
    EventRangeRow | EventRow
  >([
    env.DB.prepare(EVENT_RANGE_SQL).bind(session.officeId),
    env.DB.prepare(EVENTS_PAGE_SQL).bind(
      session.officeId,
      since,
      EVENT_PAGE_LIMIT + 1,
    ),
  ])
  const range = rangeResult.results[0] as EventRangeRow | undefined
  if (!range) return error('UNAUTHORIZED', '로그인이 필요합니다.')

  if (since > range.current_seq) {
    return cursorGone(range.current_seq)
  }

  /*
   * 보존 정리는 가장 오래된 행부터 지운다는 전제다. 다음으로 필요한 번호
   * (since + 1)가 최초 보존 번호보다 작으면 복구할 수 없는 구간이 있으므로
   * 최신부터 조용히 이어 주지 않고 전체 동기화를 요구한다.
   */
  if (
    (range.first_seq === null &&
      since < range.current_seq) ||
    (range.first_seq !== null && since < range.first_seq - 1)
  ) {
    return cursorGone(range.current_seq)
  }

  const rows = pageResult.results as EventRow[]
  if (
    !isContiguous(rows, since) ||
    rows.some((row) => row.office_seq > range.current_seq)
  ) {
    return cursorGone(range.current_seq)
  }

  const hasMore = rows.length > EVENT_PAGE_LIMIT
  const events = rows.slice(0, EVENT_PAGE_LIMIT).map(envelope)
  const nextCursor = events.at(-1)?.officeSeq ?? since

  // 남은 행이 없는데 high-water mark에 못 미치면 중간 또는 꼬리가 잘린 상태다.
  if (!hasMore && nextCursor !== range.current_seq) {
    return cursorGone(range.current_seq)
  }

  const response: EventCatchupResponse = {
    events,
    hasMore,
    nextCursor,
  }
  return json(response)
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/events',
    handler: getEvents,
  },
]
