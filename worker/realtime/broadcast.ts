import type { EventEnvelope } from '../../shared/wire/event'
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
  const hub = getOfficeHub(env, officeId)
  ctx.waitUntil(hub.broadcast(event).catch(() => undefined))
}
