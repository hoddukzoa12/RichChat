import { DurableObject } from 'cloudflare:workers'
import type { EventEnvelope } from '../../shared/wire/event'
import {
  HUB_VERIFIED_OFFICE_ID_HEADER,
  HUB_VERIFIED_USER_ID_HEADER,
  type ConnectionIdentity,
} from './protocol'

const AUTO_RESPONSE = new WebSocketRequestResponsePair('ping', 'pong')
const INTERNAL_ERROR_CLOSE_CODE = 1011

type BroadcastSocket = Pick<
  WebSocket,
  'close' | 'readyState' | 'send'
>

function closeQuietly(
  socket: BroadcastSocket,
  code: number,
  reason: string,
): void {
  try {
    socket.close(code, reason)
  } catch {
    // 이미 닫힌 연결은 런타임 연결 목록에서 제거된다.
  }
}

export function sendFrame(
  sockets: readonly BroadcastSocket[],
  frame: string,
): void {
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.OPEN) continue

    try {
      socket.send(frame)
    } catch {
      closeQuietly(
        socket,
        INTERNAL_ERROR_CLOSE_CODE,
        'broadcast failed',
      )
    }
  }
}

function connectionIdentity(
  request: Request,
): ConnectionIdentity | undefined {
  const officeId = request.headers.get(
    HUB_VERIFIED_OFFICE_ID_HEADER,
  )
  const userId = request.headers.get(HUB_VERIFIED_USER_ID_HEADER)
  if (!officeId || !userId) return undefined

  return { officeId, userId }
}

export class OfficeHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(AUTO_RESPONSE)
  }

  async fetch(request: Request): Promise<Response> {
    if (
      request.headers.get('upgrade')?.toLowerCase() !==
      'websocket'
    ) {
      return new Response('WebSocket upgrade required', {
        status: 426,
      })
    }

    const identity = connectionIdentity(request)
    if (!identity) {
      return new Response('Verified identity required', {
        status: 403,
      })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(identity)

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  broadcast(event: EventEnvelope): void {
    sendFrame(
      this.ctx.getWebSockets(),
      JSON.stringify(event),
    )
  }

  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): void {
    closeQuietly(socket, code, reason)
  }

  webSocketError(socket: WebSocket, _error: unknown): void {
    closeQuietly(
      socket,
      INTERNAL_ERROR_CLOSE_CODE,
      'connection failed',
    )
  }
}
