import {
  env,
  runInDurableObject,
  SELF,
} from 'cloudflare:test'
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest'
import type {
  EventCatchupResponse,
  EventEnvelope,
} from '../../shared/wire/event'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import { getOfficeHub } from '../realtime/broadcast'
import {
  HUB_VERIFIED_OFFICE_ID_HEADER,
  HUB_VERIFIED_USER_ID_HEADER,
  type ConnectionIdentity,
} from '../realtime/protocol'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const sockets: WebSocket[] = []
let fixtureSequence = 0

interface SessionFixture {
  officeId: string
  token: string
  userId: string
}

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

function event(
  officeSeq: number,
  suffix: string,
): EventEnvelope {
  return {
    officeSeq,
    type: 'message.created',
    entity: 'message',
    entityId: `message-${suffix}-${officeSeq}`,
    conversationId: null,
    actorKind: 'system',
    actorId: null,
    payload: { position: officeSeq },
    createdAt: 1_900_000_000_000 + officeSeq,
  }
}

async function seedSession(): Promise<SessionFixture> {
  fixtureSequence += 1
  const suffix = `realtime-${fixtureSequence}`
  const officeId = `office-${suffix}`
  const userId = `user-${suffix}`
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
        id,
        office_id,
        email,
        name,
        title,
        role,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      officeId,
      `${userId}@rich.example`,
      '박상담',
      '상담 담당',
      '상담 담당',
      '활성',
      now,
      now,
    ),
  ])

  const session = await createSession(
    env.DB,
    { userId, officeId },
    now,
  )
  return { officeId, token: session.token, userId }
}

async function storeEvents(
  officeId: string,
  events: readonly EventEnvelope[],
): Promise<void> {
  const statements = events.map((item) =>
    env.DB.prepare(
      `INSERT INTO events (
        office_id,
        office_seq,
        type,
        entity,
        entity_id,
        conversation_id,
        actor_kind,
        actor_id,
        payload,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      officeId,
      item.officeSeq,
      item.type,
      item.entity,
      item.entityId,
      item.conversationId,
      item.actorKind,
      item.actorId,
      JSON.stringify(item.payload),
      item.createdAt,
    ),
  )
  const last = events.at(-1)
  if (last) {
    statements.push(
      env.DB.prepare(
        'UPDATE offices SET event_seq = ? WHERE id = ?',
      ).bind(last.officeSeq, officeId),
    )
  }

  await env.DB.batch(statements)
}

async function realtime(
  token?: string,
  query = '',
  extraHeaders?: HeadersInit,
): Promise<Response> {
  const headers = new Headers(extraHeaders)
  headers.set('upgrade', 'websocket')
  if (token) headers.set('cookie', cookie(token))

  return SELF.fetch(
    `${ORIGIN}/api/realtime${query}`,
    { headers },
  )
}

async function openSocket(
  token: string,
  extraHeaders?: HeadersInit,
): Promise<WebSocket> {
  const response = await realtime(token, '', extraHeaders)
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (!socket) throw new Error('WebSocket 응답이 필요합니다.')

  socket.accept()
  sockets.push(socket)
  return socket
}

function messages(
  socket: WebSocket,
  count: number,
): Promise<EventEnvelope[]> {
  return new Promise((resolve) => {
    const received: EventEnvelope[] = []
    const listener = (event: MessageEvent) => {
      received.push(
        JSON.parse(String(event.data)) as EventEnvelope,
      )
      if (received.length !== count) return

      socket.removeEventListener('message', listener)
      resolve(received)
    }
    socket.addEventListener('message', listener)
  })
}

function close(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.addEventListener('close', () => resolve(), {
      once: true,
    })
    socket.close(1000, 'test close')
  })
}

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close(1000, 'test complete')
  }
})

describe('Realtime route', () => {
  it('rejects an upgrade without a session cookie', async () => {
    const response = await realtime()

    expect(response.status).toBe(401)
  })

  it('does not accept a session token from the URL', async () => {
    const session = await seedSession()
    const response = await realtime(
      undefined,
      `?token=${session.token}`,
    )

    expect(response.status).toBe(401)
  })

  it('forwards only identity verified from the session', async () => {
    const session = await seedSession()
    await openSocket(session.token, {
      [HUB_VERIFIED_OFFICE_ID_HEADER]: 'spoofed-office',
      [HUB_VERIFIED_USER_ID_HEADER]: 'spoofed-user',
    })
    const hub = getOfficeHub(env, session.officeId)

    const attachments = await runInDurableObject(
      hub,
      (_instance, state) =>
        state
          .getWebSockets()
          .map(
            (socket) =>
              socket.deserializeAttachment() as ConnectionIdentity,
          ),
    )

    expect(attachments).toEqual([
      {
        officeId: session.officeId,
        userId: session.userId,
      },
    ])
  })

  it('fans out contiguous catchup envelopes to two office sockets', async () => {
    const session = await seedSession()
    const stored = [
      event(1, session.officeId),
      event(2, session.officeId),
    ]
    await storeEvents(session.officeId, stored)
    const first = await openSocket(session.token)
    const second = await openSocket(session.token)
    const firstFrames = messages(first, stored.length)
    const secondFrames = messages(second, stored.length)
    const hub = getOfficeHub(env, session.officeId)

    for (const frame of stored) {
      await hub.broadcast(frame)
    }

    await expect(firstFrames).resolves.toEqual(stored)
    await expect(secondFrames).resolves.toEqual(stored)

    const catchupResponse = await SELF.fetch(
      `${ORIGIN}/api/events?since=0`,
      {
        headers: { cookie: cookie(session.token) },
      },
    )
    expect(catchupResponse.status).toBe(200)
    const catchup =
      await catchupResponse.json<EventCatchupResponse>()
    expect(catchup.events).toEqual(stored)
    expect(
      catchup.events.map((item) => item.officeSeq),
    ).toEqual([1, 2])
  })

  it('does not fan out an event to another office hub', async () => {
    const firstSession = await seedSession()
    const secondSession = await seedSession()
    const stored = [event(1, firstSession.officeId)]
    await storeEvents(firstSession.officeId, stored)
    const firstSocket = await openSocket(firstSession.token)
    const secondSocket = await openSocket(secondSession.token)
    const firstFrames = messages(firstSocket, 1)
    const secondFrames: EventEnvelope[] = []
    secondSocket.addEventListener('message', (received) => {
      secondFrames.push(
        JSON.parse(String(received.data)) as EventEnvelope,
      )
    })
    const firstHub = getOfficeHub(env, firstSession.officeId)
    const secondHub = getOfficeHub(env, secondSession.officeId)

    expect(firstHub.id.equals(secondHub.id)).toBe(false)
    await firstHub.broadcast(stored[0]!)

    await expect(firstFrames).resolves.toEqual(stored)
    expect(secondFrames).toEqual([])
  })

  it('removes a closed socket while the other keeps receiving', async () => {
    const session = await seedSession()
    const stored = [event(1, session.officeId)]
    await storeEvents(session.officeId, stored)
    const closedSocket = await openSocket(session.token)
    const remainingSocket = await openSocket(session.token)
    const hub = getOfficeHub(env, session.officeId)

    await close(closedSocket)
    await expect(
      runInDurableObject(
        hub,
        (_instance, state) => state.getWebSockets().length,
      ),
    ).resolves.toBe(1)

    const remainingFrames = messages(remainingSocket, 1)
    await hub.broadcast(stored[0]!)

    await expect(remainingFrames).resolves.toEqual(stored)
  })
})
