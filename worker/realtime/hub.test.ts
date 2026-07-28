import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { EventEnvelope } from '../../shared/wire/event'
import { publish } from '../db/events'
import {
  broadcastAfterCommit,
  getOfficeHub,
} from './broadcast'
import { sendFrame } from './hub'
import {
  HUB_CONNECT_URL,
  HUB_VERIFIED_OFFICE_ID_HEADER,
  HUB_VERIFIED_USER_ID_HEADER,
  type ConnectionIdentity,
} from './protocol'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const sockets: WebSocket[] = []
let sequence = 0

function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}-${sequence}`
}

function event(
  officeSeq: number,
  entityId = `message-${officeSeq}`,
): EventEnvelope {
  return {
    officeSeq,
    type: 'message.created',
    entity: 'message',
    entityId,
    conversationId: null,
    actorKind: 'system',
    actorId: null,
    payload: { officeSeq },
    createdAt: 1_900_000_000_000 + officeSeq,
  }
}

function message(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.addEventListener(
      'message',
      (received) => resolve(String(received.data)),
      { once: true },
    )
  })
}

async function connect(
  officeId: string,
  userId: string,
): Promise<{
  socket: WebSocket
  stub: DurableObjectStub<Env['OFFICE_HUB'] extends
    DurableObjectNamespace<infer Hub>
    ? Hub
    : never>
}> {
  const stub = getOfficeHub(env, officeId)
  const response = await stub.fetch(HUB_CONNECT_URL, {
    headers: {
      upgrade: 'websocket',
      [HUB_VERIFIED_OFFICE_ID_HEADER]: officeId,
      [HUB_VERIFIED_USER_ID_HEADER]: userId,
    },
  })
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (!socket) throw new Error('WebSocket 응답이 필요합니다.')

  socket.accept()
  sockets.push(socket)
  return { socket, stub }
}

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close(1000, 'test complete')
  }
})

describe('OfficeHub', () => {
  it('keeps verified identity as a hibernation attachment', async () => {
    const officeId = nextId('hub-office')
    const userId = nextId('hub-user')
    const { stub } = await connect(officeId, userId)

    const attachments = await runInDurableObject(
      stub,
      (_instance, state) =>
        state
          .getWebSockets()
          .map(
            (socket) =>
              socket.deserializeAttachment() as ConnectionIdentity,
          ),
    )

    expect(attachments).toEqual([{ officeId, userId }])
  })

  it('handles application ping without waking message code', async () => {
    const { socket } = await connect(
      nextId('ping-office'),
      nextId('ping-user'),
    )
    const pong = message(socket)

    socket.send('ping')

    await expect(pong).resolves.toBe('pong')
  })

  it('continues fanout after one socket send fails', () => {
    const delivered: string[] = []
    const failedClose = vi.fn()
    const failing = {
      readyState: WebSocket.OPEN,
      send: () => {
        throw new Error('buffer full')
      },
      close: failedClose,
    }
    const working = {
      readyState: WebSocket.OPEN,
      send: (frame: string | ArrayBuffer | ArrayBufferView) => {
        delivered.push(String(frame))
      },
      close: vi.fn(),
    }

    sendFrame([failing, working], 'frame')

    expect(failedClose).toHaveBeenCalledWith(
      1011,
      'broadcast failed',
    )
    expect(delivered).toEqual(['frame'])
  })

  it('keeps a committed event when deferred broadcast rejects', async () => {
    const officeId = nextId('commit-office')
    const frame = event(1, nextId('commit-message'))
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
      ).bind(officeId, '세무법인 리치', frame.createdAt),
      ...publish(env.DB, {
        officeId,
        type: frame.type,
        entity: frame.entity,
        entityId: frame.entityId,
        conversationId: frame.conversationId,
        actorKind: frame.actorKind,
        actorId: frame.actorId,
        payload: frame.payload,
        createdAt: frame.createdAt,
      }),
    ])

    const broadcast = vi
      .fn()
      .mockRejectedValue(new Error('hub unavailable'))
    const failingEnv = {
      OFFICE_HUB: {
        getByName: () => ({ broadcast }),
      },
    } as unknown as Pick<Env, 'OFFICE_HUB'>
    const ctx = createExecutionContext()

    broadcastAfterCommit(
      ctx,
      failingEnv,
      officeId,
      frame,
    )
    await waitOnExecutionContext(ctx)

    expect(broadcast).toHaveBeenCalledWith(frame)
    await expect(
      env.DB.prepare(
        `SELECT office_seq, entity_id
         FROM events
         WHERE office_id = ?`,
      )
        .bind(officeId)
        .first(),
    ).resolves.toEqual({
      office_seq: 1,
      entity_id: frame.entityId,
    })
  })
})
