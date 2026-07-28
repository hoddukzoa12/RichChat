import { error } from '../http/error'
import type { Route } from '../http/router'
import { requireSession } from '../http/session'
import { getOfficeHub } from '../realtime/broadcast'
import {
  HUB_CONNECT_URL,
  HUB_VERIFIED_OFFICE_ID_HEADER,
  HUB_VERIFIED_USER_ID_HEADER,
} from '../realtime/protocol'

async function connect(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  if (
    request.headers.get('upgrade')?.toLowerCase() !==
    'websocket'
  ) {
    return error(
      'BAD_REQUEST',
      'WebSocket 업그레이드가 필요합니다.',
    )
  }

  /*
   * 외부 요청 헤더를 전달하지 않고, 세션 검증 뒤 얻은 신원만 내부 요청에
   * 다시 싣는다. 따라서 DO는 D1이나 쿠키를 다시 읽지 않는다.
   */
  const headers = new Headers({
    upgrade: 'websocket',
    [HUB_VERIFIED_OFFICE_ID_HEADER]: session.officeId,
    [HUB_VERIFIED_USER_ID_HEADER]: session.userId,
  })
  return getOfficeHub(env, session.officeId).fetch(
    new Request(HUB_CONNECT_URL, { headers }),
  )
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/realtime',
    handler: connect,
  },
]
