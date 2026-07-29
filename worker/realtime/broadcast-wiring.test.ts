import {
  createExecutionContext,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { EventCatchupResponse } from '../../shared/wire/event'
import { publish } from '../db/events'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import { dispatch } from '../http/router'
import type { LguRequest } from '../lgu/send'
import { createMessageSendRoutes } from '../routes/messages-send'
import { createNoteRoutes } from '../routes/notes'
import { executeBatchAndBroadcast } from './broadcast'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const sockets: WebSocket[] = []
let fixtureSequence = 0

interface Fixture {
  actorId: string
  conversationId: string
  customerPhone: string
  officeId: string
  otherToken: string
  token: string
}

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function seedFixture(): Promise<Fixture> {
  fixtureSequence += 1
  const suffix = `broadcast-wiring-${fixtureSequence}`
  const officeId = `office-${suffix}`
  const actorId = `actor-${suffix}`
  const otherUserId = `other-${suffix}`
  const customerId = `customer-${suffix}`
  const conversationId = `conversation-${suffix}`
  const customerPhone = `+8210${String(fixtureSequence).padStart(8, '0')}`
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    ...[actorId, otherUserId].map((userId, index) =>
      env.DB.prepare(
        `INSERT INTO users (
          id, office_id, email, name, title, role, status, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
      ).bind(
        userId,
        officeId,
        `${userId}@rich.test`,
        index === 0 ? '박상담' : '김상담',
        '상담 담당',
        now,
        now,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      customerPhone,
      '테스트 고객',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, '미처리', ?, ?)`,
    ).bind(conversationId, officeId, customerId, now, now),
    env.DB.prepare(
      `INSERT INTO office_channels (
        id, office_id, value, label, is_default, active, created_at
      ) VALUES (?, ?, '0255550000', '', 1, 1, ?)`,
    ).bind(`channel-${suffix}`, officeId, now),
  ])

  const session = await createSession(
    env.DB,
    { userId: actorId, officeId },
    now,
  )
  const otherSession = await createSession(
    env.DB,
    { userId: otherUserId, officeId },
    now,
  )

  return {
    actorId,
    conversationId,
    customerPhone,
    officeId,
    otherToken: otherSession.token,
    token: session.token,
  }
}

async function openSocket(token: string): Promise<WebSocket> {
  const response = await SELF.fetch(`${ORIGIN}/api/realtime`, {
    headers: {
      cookie: cookie(token),
      upgrade: 'websocket',
    },
  })
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (!socket) throw new Error('WebSocket 응답이 필요합니다.')

  socket.accept()
  sockets.push(socket)
  return socket
}

function frames(socket: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    const received: string[] = []
    const listener = (message: MessageEvent) => {
      received.push(String(message.data))
      if (received.length !== count) return

      socket.removeEventListener('message', listener)
      resolve(received)
    }
    socket.addEventListener('message', listener)
  })
}

function request(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({
    cookie: cookie(token),
    origin: ORIGIN,
  })
  if (body !== undefined) {
    headers.set('content-type', 'application/json')
  }

  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function catchup(
  fixture: Fixture,
): Promise<EventCatchupResponse> {
  const response = await SELF.fetch(`${ORIGIN}/api/events?since=0`, {
    headers: { cookie: cookie(fixture.token) },
  })
  expect(response.status).toBe(200)
  return response.json<EventCatchupResponse>()
}

function acceptedLguRequest(): LguRequest {
  return async <T>(
    _env: Parameters<LguRequest>[0],
    _officeId: string,
    _service: Parameters<LguRequest>[2],
    _path: string,
    init: RequestInit,
  ): Promise<T> => {
    const body = JSON.parse(String(init.body)) as {
      recvInfoLst: Array<{ cliKey: string }>
    }
    const providerKey = body.recvInfoLst[0]?.cliKey
    return {
      code: '10000',
      data: [
        {
          cliKey: providerKey,
          msgKey: `msg-${providerKey}`,
          code: '10000',
        },
      ],
    } as T
  }
}

function moBody(fixture: Fixture, moKey: string): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .replace(/\D/g, '')
    .slice(0, 14)
  return JSON.stringify({
    moCnt: 1,
    moLst: [
      {
        moKey,
        moNumber: '15445367',
        moType: 'SMSMO',
        moCallback: `0${fixture.customerPhone.slice(3)}`,
        moMsg: '부가세 문의드려요',
        moRecvDt: kst,
        telco: 'LGU',
        contentCnt: 0,
        contentInfoLst: [],
      },
    ],
  })
}

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close(1000, 'test complete')
  }
})

describe('Broadcast wiring', () => {
  it('fans out send, status, and note commits with byte-identical catchup envelopes', async () => {
    const fixture = await seedFixture()
    const socket = await openSocket(fixture.token)
    const received = frames(socket, 4)

    const statusResponse = await request(
      'PATCH',
      `/api/conversations/${fixture.conversationId}`,
      fixture.token,
      { status: '완료', version: 1 },
    )
    expect(statusResponse.status).toBe(200)

    const noteResponse = await request(
      'POST',
      `/api/conversations/${fixture.conversationId}/notes`,
      fixture.token,
      { body: '신고 자료 확인 필요' },
    )
    expect(noteResponse.status).toBe(201)

    const sendContext = createExecutionContext()
    const sendResponse = await dispatch(
      new Request(
        `${ORIGIN}/api/conversations/${fixture.conversationId}/messages`,
        {
          method: 'POST',
          headers: {
            cookie: cookie(fixture.token),
            'content-type': 'application/json',
            origin: ORIGIN,
          },
          body: JSON.stringify({
            clientKey: `client-${fixture.officeId}`,
            body: '확인 후 답변드리겠습니다',
          }),
        },
      ),
      env,
      createMessageSendRoutes({
        lguRequest: acceptedLguRequest(),
      }),
      sendContext,
    )
    expect(sendResponse?.status).toBe(201)
    await waitOnExecutionContext(sendContext)

    const rawFrames = await received
    const events = await catchup(fixture)
    expect(
      rawFrames.map((raw) => JSON.parse(raw) as { type: string }),
    ).toEqual([
      expect.objectContaining({ type: 'conversation.updated' }),
      expect.objectContaining({ type: 'note.created' }),
      expect.objectContaining({ type: 'message.created' }),
      expect.objectContaining({ type: 'message.delivery_updated' }),
    ])
    expect(rawFrames).toEqual(
      events.events.map((event) => JSON.stringify(event)),
    )
    expect(events.events.map((event) => event.officeSeq)).toEqual([
      1, 2, 3, 4,
    ])
  })

  it('fans out MO once and skips idempotent and forbidden zero-row changes', async () => {
    const fixture = await seedFixture()
    const socket = await openSocket(fixture.token)
    const firstFrame = frames(socket, 1)
    const body = moBody(fixture, `mo-${fixture.officeId}`)

    const firstMo = await SELF.fetch(
      `${ORIGIN}/api/hooks/lgu/mo/${env.LGU_MO_WEBHOOK_SECRET}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
    )
    expect(firstMo.status).toBe(200)
    expect(JSON.parse((await firstFrame)[0]!) as { type: string }).toEqual(
      expect.objectContaining({ type: 'message.created' }),
    )

    const nextFrame = frames(socket, 1)
    const duplicateMo = await SELF.fetch(
      `${ORIGIN}/api/hooks/lgu/mo/${env.LGU_MO_WEBHOOK_SECRET}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
    )
    expect(duplicateMo.status).toBe(200)

    const forbidden = await request(
      'PATCH',
      '/api/office/settings',
      fixture.otherToken,
      { retentionYears: 4 },
    )
    expect(forbidden.status).toBe(403)

    const valid = await request(
      'PATCH',
      `/api/conversations/${fixture.conversationId}`,
      fixture.token,
      { status: '완료', version: 2 },
    )
    expect(valid.status).toBe(200)
    const next = JSON.parse((await nextFrame)[0]!) as {
      officeSeq: number
      type: string
    }
    expect(next).toMatchObject({
      officeSeq: 2,
      type: 'conversation.updated',
    })
    expect((await catchup(fixture)).events).toHaveLength(2)
  })

  it('fans out a committed delivery report webhook', async () => {
    const fixture = await seedFixture()
    const messageId = `report-message-${fixture.officeId}`
    const clientKey = `report-client-${fixture.officeId}`
    const msgKey = `report-msg-${fixture.officeId}`
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO messages (
        id, office_id, conversation_id, direction, channel, body,
        sender_user_id, occurred_at, created_at, client_key, msg_key,
        delivery_status
      ) VALUES (?, ?, ?, 'out', 'SMS', ?, ?, ?, ?, ?, ?, '접수')`,
    )
      .bind(
        messageId,
        fixture.officeId,
        fixture.conversationId,
        '리포트 대기 메시지',
        fixture.actorId,
        now,
        now,
        clientKey,
        msgKey,
      )
      .run()
    const socket = await openSocket(fixture.token)
    const received = frames(socket, 1)

    const response = await SELF.fetch(
      `${ORIGIN}/api/hooks/lgu/report/${env.LGU_REPORT_WEBHOOK_SECRET}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rptCnt: 1,
          rptLst: [
            {
              cliKey: clientKey,
              msgKey,
              resultCode: '10000',
              resultCodeDesc: '성공',
              rptDt: '2026-07-28T12:00:00',
            },
          ],
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(JSON.parse((await received)[0]!) as {
      entityId: string
      type: string
    }).toMatchObject({
      entityId: messageId,
      type: 'message.delivery_updated',
    })
    expect((await catchup(fixture)).events).toHaveLength(1)
  })

  it('does not fan out a publication from a rolled-back batch', async () => {
    const fixture = await seedFixture()
    const socket = await openSocket(fixture.token)
    const received = frames(socket, 1)
    const publication = publish(env.DB, {
      officeId: fixture.officeId,
      type: 'conversation.updated',
      entity: 'conversation',
      entityId: fixture.conversationId,
      conversationId: fixture.conversationId,
      actorKind: 'user',
      actorId: fixture.actorId,
      payload: { status: '처리중', version: 2 },
      createdAt: Date.now(),
    })
    const statements = [
      env.DB.prepare(
        `UPDATE conversations
         SET status = '처리중', version = 2
         WHERE id = ?`,
      ).bind(fixture.conversationId),
      ...publication,
      env.DB.prepare(
        'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
      ).bind(fixture.officeId, '중복 사무소', Date.now()),
    ]
    const failedContext = createExecutionContext()

    await expect(
      executeBatchAndBroadcast(
        env.DB,
        statements,
        [publication],
        failedContext,
        env,
      ),
    ).rejects.toThrow('D1 batch 실행에 실패했습니다.')
    await waitOnExecutionContext(failedContext)

    const valid = await request(
      'PATCH',
      `/api/conversations/${fixture.conversationId}`,
      fixture.token,
      { status: '완료', version: 1 },
    )
    expect(valid.status).toBe(200)
    const frame = JSON.parse((await received)[0]!) as {
      officeSeq: number
      payload: { status: string }
    }
    expect(frame).toMatchObject({
      officeSeq: 1,
      payload: { status: '완료' },
    })
    expect((await catchup(fixture)).events).toHaveLength(1)
  })

  it('returns after commit without waiting for a failing broadcast', async () => {
    const fixture = await seedFixture()
    const route = createNoteRoutes().find(
      ({ method }) => method === 'POST',
    )
    if (!route) throw new Error('메모 생성 라우트가 필요합니다.')

    let rejectBroadcast: ((reason: Error) => void) | undefined
    const pendingBroadcast = new Promise<void>((_resolve, reject) => {
      rejectBroadcast = reject
    })
    const broadcast = vi.fn(() => pendingBroadcast)
    const failingEnv = {
      DB: env.DB,
      OFFICE_HUB: {
        getByName: () => ({ broadcast }),
      },
    } as unknown as Env
    const ctx = createExecutionContext()
    const responsePromise = route.handler(
      new Request(
        `${ORIGIN}/api/conversations/${fixture.conversationId}/notes`,
        {
          method: 'POST',
          headers: {
            cookie: cookie(fixture.token),
            'content-type': 'application/json',
            origin: ORIGIN,
          },
          body: JSON.stringify({ body: '방송 장애 중 작성' }),
        },
      ),
      failingEnv,
      { id: fixture.conversationId },
      ctx,
    )
    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('응답이 방송 완료를 기다렸습니다.')),
          500,
        )
      }),
    ])

    expect(response.status).toBe(201)
    expect(broadcast).toHaveBeenCalledOnce()
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM events
         WHERE office_id = ? AND type = 'note.created'`,
      )
        .bind(fixture.officeId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 })

    rejectBroadcast?.(new Error('hub unavailable'))
    await waitOnExecutionContext(ctx)
  })
})
