import type { EventEnvelope } from '../../shared/wire/event'
import { executeBatch } from '../db/d1'
import {
  eventEnvelope,
  type EventPublication,
  type PublishedEventRow,
} from '../db/events'
import type { OfficeHub } from './hub'

export function getOfficeHub(
  env: Pick<Env, 'OFFICE_HUB'>,
  officeId: string,
): DurableObjectStub<OfficeHub> {
  return env.OFFICE_HUB.getByName(officeId)
}

/**
 * 원인 변경과 이벤트 행의 D1 커밋이 끝난 뒤 호출한다.
 * 팬아웃은 유실 가능하므로 실패를 응답 경로로 되돌리지 않는다.
 */
export function broadcastAfterCommit(
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  env: Pick<Env, 'OFFICE_HUB'>,
  officeId: string,
  event: EventEnvelope,
): void {
  try {
    const hub = getOfficeHub(env, officeId)
    ctx.waitUntil(hub.broadcast(event).catch(() => undefined))
  } catch {
    // 바인딩 또는 waitUntil 오류도 이미 끝난 D1 커밋과 응답을 되돌리지 않는다.
  }
}

/**
 * 이벤트 INSERT의 RETURNING 행을 커밋 완료 뒤 같은 봉투 변환기로 방송한다.
 * 가드가 거짓이면 반환 행이 없으므로 아무 프레임도 예약하지 않는다.
 */
export async function executeBatchAndBroadcast<T = unknown>(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
  publications: readonly EventPublication[],
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  env: Pick<Env, 'OFFICE_HUB'> | undefined,
): Promise<D1Result<T>[]> {
  const results = await executeBatch<T>(db, statements)
  if (!ctx || !env) return results

  for (const publication of publications) {
    const insertionIndex = statements.indexOf(publication[1])
    const row = results[insertionIndex]?.results[0] as
      | PublishedEventRow
      | undefined
    if (!row) continue

    try {
      broadcastAfterCommit(
        ctx,
        env,
        row.office_id,
        eventEnvelope(row),
      )
    } catch {
      // 영속 이벤트가 남으므로 팬아웃 변환 실패도 응답 경로로 되돌리지 않는다.
    }
  }

  return results
}
