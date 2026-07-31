import { env, fetchMock, SELF } from 'cloudflare:test'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest'
import {
  CONVERSATION_LIST_DEFAULT_LIMIT,
  type ConversationComposeOptionsResponse,
  type ConversationListResponse,
  type ConversationStartResponse,
} from '../../shared/wire/conversation'
import { storeInboundMessage } from '../inbound-message'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const GATEWAY_URL = new URL(env.SMS_GATEWAY_API_URL)
const GATEWAY_MESSAGES_PATH =
  `${GATEWAY_URL.pathname.replace(/\/+$/, '')}/messages`

interface Fixture {
  actorId: string
  existingConversationId: string
  existingCustomerId: string
  officeId: string
  phoneAId: string
  phoneBDeviceId: string
  phoneBId: string
  token: string
}

interface GatewayRequest {
  deviceId: string
  id: string
  phoneNumbers: string[]
  simNumber: number
  textMessage: { text: string }
  withDeliveryReport: boolean
}

let fixtureSequence = 0
const gatewayRequests: GatewayRequest[] = []

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterEach(() => {
  fetchMock.assertNoPendingInterceptors()
  gatewayRequests.length = 0
})

afterAll(() => {
  fetchMock.deactivate()
})

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function seedFixture(): Promise<Fixture> {
  fixtureSequence += 1
  const key = `compose-${fixtureSequence}`
  const officeId = `office-${key}`
  const actorId = `actor-${key}`
  const existingCustomerId = `customer-${key}`
  const existingConversationId = `conversation-${key}`
  const defaultChannelId = `channel-default-${key}`
  const phoneAId = `channel-phone-a-${key}`
  const phoneBId = `channel-phone-b-${key}`
  const inactivePhoneId = `channel-inactive-${key}`
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
         id, office_id, email, name, title, role, status, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    ).bind(
      actorId,
      officeId,
      `${actorId}@rich.test`,
      '박상담',
      '상담 담당',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO office_channels (
         id, office_id, value, label, is_default, active, created_at,
         device_id
       ) VALUES (?, ?, ?, ?, 1, 1, ?, NULL)`,
    ).bind(
      defaultChannelId,
      officeId,
      '0255550000',
      '대표번호',
      now,
    ),
    env.DB.prepare(
      `INSERT INTO office_channels (
         id, office_id, value, label, is_default, active, created_at,
         device_id
       ) VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
    ).bind(
      phoneAId,
      officeId,
      '01011112222',
      '상담실',
      now + 1,
      `device-phone-a-${key}`,
    ),
    env.DB.prepare(
      `INSERT INTO office_channels (
         id, office_id, value, label, is_default, active, created_at,
         device_id
       ) VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
    ).bind(
      phoneBId,
      officeId,
      '01033334444',
      '외근폰',
      now + 2,
      `device-phone-b-${key}`,
    ),
    env.DB.prepare(
      `INSERT INTO office_channels (
         id, office_id, value, label, is_default, active, created_at,
         device_id
       ) VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    ).bind(
      inactivePhoneId,
      officeId,
      '01055556666',
      '휴면폰',
      now + 3,
      `device-inactive-${key}`,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
         id, office_id, phone_e164, name, company, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      existingCustomerId,
      officeId,
      '+821077778888',
      '김리치',
      '리치상사',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
         id, office_id, customer_id, office_channel_id, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, '완료', ?, ?)`,
    ).bind(
      existingConversationId,
      officeId,
      existingCustomerId,
      phoneAId,
      now,
      now,
    ),
  ])
  const session = await createSession(
    env.DB,
    { userId: actorId, officeId },
    now,
  )

  return {
    actorId,
    existingConversationId,
    existingCustomerId,
    officeId,
    phoneAId,
    phoneBDeviceId: `device-phone-b-${key}`,
    phoneBId,
    token: session.token,
  }
}

function composeOptions(
  token?: string,
  query = '',
): Promise<Response> {
  const suffix = query
    ? `?${new URLSearchParams({ q: query })}`
    : ''
  return SELF.fetch(`${ORIGIN}/api/conversations/compose${suffix}`, {
    headers: token ? { cookie: cookie(token) } : undefined,
  })
}

function startConversation(
  body: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  const headers = new Headers({
    origin: ORIGIN,
    'content-type': 'application/json',
  })
  if (token) headers.set('cookie', cookie(token))

  return SELF.fetch(`${ORIGIN}/api/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function sendMessage(
  conversationId: string,
  token: string,
): Promise<Response> {
  return SELF.fetch(
    `${ORIGIN}/api/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: {
        cookie: cookie(token),
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientKey: 'compose-selected-device',
        body: '선택한 업무폰으로 보냅니다',
      }),
    },
  )
}

function mockGateway(deviceId: string): void {
  fetchMock
    .get(GATEWAY_URL.origin)
    .intercept({
      method: 'POST',
      path: GATEWAY_MESSAGES_PATH,
      headers: {
        authorization:
          `Basic ${btoa('test-gateway-user:test-gateway-password')}`,
        'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
      },
    })
    .reply(
      200,
      ({ body }) => {
        const request = JSON.parse(String(body)) as GatewayRequest
        gatewayRequests.push(request)
        return JSON.stringify({
          id: request.id,
          deviceId,
          state: 'Processed',
          recipients: [
            {
              phoneNumber: request.phoneNumbers[0],
              state: 'Processed',
              error: null,
            },
          ],
        })
      },
      { headers: { 'content-type': 'application/json' } },
    )
}

describe('Conversation compose API', () => {
  it('requires authentication for options and creation', async () => {
    const [options, creation] = await Promise.all([
      composeOptions(),
      startConversation({
        officeChannelId: 'phone-without-session',
        phone: '01012345678',
      }),
    ])

    expect(options.status).toBe(401)
    expect(creation.status).toBe(401)
  })

  it('lists only active gateway phones and searches customers', async () => {
    const fixture = await seedFixture()
    const byName = await composeOptions(fixture.token, '김리치')
    const byPhone = await composeOptions(
      fixture.token,
      '010-7777-8888',
    )
    const nameBody =
      await byName.json<ConversationComposeOptionsResponse>()
    const phoneBody =
      await byPhone.json<ConversationComposeOptionsResponse>()

    expect(byName.status).toBe(200)
    expect(nameBody.phones.map(({ id }) => id)).toEqual([
      fixture.phoneAId,
      fixture.phoneBId,
    ])
    expect(nameBody.customers).toEqual([
      {
        id: fixture.existingCustomerId,
        name: '김리치',
        company: '리치상사',
        phoneE164: '+821077778888',
      },
    ])
    expect(phoneBody.customers).toEqual(nameBody.customers)
  })

  it('creates one normalized empty conversation and assigns its author', async () => {
    const fixture = await seedFixture()
    const first = await startConversation(
      {
        officeChannelId: fixture.phoneBId,
        phone: '010-1234-5678',
      },
      fixture.token,
    )
    const second = await startConversation(
      {
        officeChannelId: fixture.phoneBId,
        phone: '01012345678',
      },
      fixture.token,
    )
    const firstBody = await first.json<ConversationStartResponse>()
    const secondBody = await second.json<ConversationStartResponse>()

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(secondBody).toEqual(firstBody)
    expect(firstBody.customerPhoneE164).toBe('+821012345678')

    const stored = await env.DB.prepare(
      `SELECT
         conversation.id,
         conversation.status,
         conversation.last_message_id,
         conversation.last_message_at,
         customer.phone_e164,
         assignee.user_id
       FROM conversations AS conversation
       INNER JOIN customers AS customer
         ON customer.id = conversation.customer_id
       LEFT JOIN conversation_assignees AS assignee
         ON assignee.conversation_id = conversation.id
       WHERE conversation.office_id = ?
         AND customer.phone_e164 = ?
         AND conversation.office_channel_id = ?`,
    )
      .bind(
        fixture.officeId,
        '+821012345678',
        fixture.phoneBId,
      )
      .all<{
        id: string
        status: string
        last_message_id: string | null
        last_message_at: number | null
        phone_e164: string
        user_id: string | null
      }>()
    expect(stored.results).toEqual([
      {
        id: firstBody.conversationId,
        status: '처리중',
        last_message_id: null,
        last_message_at: null,
        phone_e164: '+821012345678',
        user_id: fixture.actorId,
      },
    ])

    const listResponse = await SELF.fetch(
      `${ORIGIN}/api/conversations?${new URLSearchParams({
        q: '01012345678',
      })}`,
      { headers: { cookie: cookie(fixture.token) } },
    )
    const list = await listResponse.json<ConversationListResponse>()
    expect(list.conversations).toEqual([
      expect.objectContaining({
        id: firstBody.conversationId,
        preview: '',
        lastMessageAt: null,
      }),
    ])
  })

  it('keeps a refreshed empty conversation on a full first page', async () => {
    const fixture = await seedFixture()
    const now = Date.now() - 60_000
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `UPDATE conversations
         SET archived_at = ?
         WHERE id = ?`,
      ).bind(now, fixture.existingConversationId),
    ]
    for (
      let index = 0;
      index < CONVERSATION_LIST_DEFAULT_LIMIT;
      index += 1
    ) {
      const customerId =
        `compose-page-customer-${fixtureSequence}-${index}`
      statements.push(
        env.DB.prepare(
          `INSERT INTO customers (
             id, office_id, phone_e164, name, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          customerId,
          fixture.officeId,
          `+82109000${String(index).padStart(4, '0')}`,
          `기존 고객 ${index}`,
          now - index,
          now - index,
        ),
        env.DB.prepare(
          `INSERT INTO conversations (
             id, office_id, customer_id, office_channel_id, status,
             last_message_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, '완료', ?, ?, ?)`,
        ).bind(
          `compose-page-conversation-${fixtureSequence}-${index}`,
          fixture.officeId,
          customerId,
          fixture.phoneBId,
          now - index,
          now - index,
          now - index,
        ),
      )
    }
    await env.DB.batch(statements)

    const response = await startConversation(
      {
        officeChannelId: fixture.phoneBId,
        phone: '010-4444-5555',
      },
      fixture.token,
    )
    const started = await response.json<ConversationStartResponse>()
    expect(response.status).toBe(201)

    const listResponse = await SELF.fetch(
      `${ORIGIN}/api/conversations`,
      { headers: { cookie: cookie(fixture.token) } },
    )
    const list = await listResponse.json<ConversationListResponse>()

    expect(list.conversations).toHaveLength(
      CONVERSATION_LIST_DEFAULT_LIMIT,
    )
    expect(list.conversations[0]).toEqual(
      expect.objectContaining({
        id: started.conversationId,
        lastMessageAt: null,
        preview: '',
      }),
    )
    expect(list.nextCursor).not.toBeNull()
  })

  it('promotes an empty conversation when its first inbound message arrives', async () => {
    const fixture = await seedFixture()
    const targetResponse = await startConversation(
      {
        officeChannelId: fixture.phoneBId,
        phone: '010-1111-9999',
      },
      fixture.token,
    )
    const rivalResponse = await startConversation(
      {
        officeChannelId: fixture.phoneBId,
        phone: '010-2222-9999',
      },
      fixture.token,
    )
    const target = await targetResponse.json<ConversationStartResponse>()
    const rival = await rivalResponse.json<ConversationStartResponse>()
    const baseTime = Date.now() - 10_000
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE conversations SET created_at = ? WHERE id = ?',
      ).bind(baseTime, target.conversationId),
      env.DB.prepare(
        'UPDATE conversations SET created_at = ? WHERE id = ?',
      ).bind(baseTime + 1, rival.conversationId),
    ])

    const beforeResponse = await SELF.fetch(
      `${ORIGIN}/api/conversations`,
      { headers: { cookie: cookie(fixture.token) } },
    )
    const before = await beforeResponse.json<ConversationListResponse>()
    const beforeIds = before.conversations.map(({ id }) => id)
    expect(beforeIds.indexOf(rival.conversationId)).toBeLessThan(
      beforeIds.indexOf(target.conversationId),
    )

    const occurredAt = Date.now() + 1_000
    await storeInboundMessage(env, {
      officeId: fixture.officeId,
      officeChannelId: fixture.phoneBId,
      customerPhoneE164: '+821011119999',
      channel: 'SMS',
      title: null,
      body: '처음 도착한 고객 문의',
      occurredAt,
      occurredAtCanonical: true,
      receivedAt: Date.now(),
      idempotencyKey: `compose-first-inbound-${fixtureSequence}`,
    })

    const afterResponse = await SELF.fetch(
      `${ORIGIN}/api/conversations`,
      { headers: { cookie: cookie(fixture.token) } },
    )
    const after = await afterResponse.json<ConversationListResponse>()
    expect(after.conversations[0]).toEqual(
      expect.objectContaining({
        id: target.conversationId,
        lastMessageAt: occurredAt,
        preview: '처음 도착한 고객 문의',
      }),
    )
    const stored = await env.DB.prepare(
      `SELECT last_message_at
       FROM conversations
       WHERE id = ?`,
    )
      .bind(target.conversationId)
      .first<{ last_message_at: number | null }>()
    expect(stored?.last_message_at).toBe(occurredAt)
  })

  it('opens an existing customer conversation without changing it', async () => {
    const fixture = await seedFixture()
    const first = await startConversation(
      {
        officeChannelId: fixture.phoneAId,
        customerId: fixture.existingCustomerId,
      },
      fixture.token,
    )
    const second = await startConversation(
      {
        officeChannelId: fixture.phoneAId,
        customerId: fixture.existingCustomerId,
      },
      fixture.token,
    )
    const firstBody = await first.json<ConversationStartResponse>()
    const secondBody = await second.json<ConversationStartResponse>()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(firstBody.conversationId).toBe(
      fixture.existingConversationId,
    )
    expect(secondBody).toEqual(firstBody)

    const rows = await env.DB.prepare(
      `SELECT status
       FROM conversations
       WHERE office_id = ?
         AND customer_id = ?
         AND office_channel_id = ?`,
    )
      .bind(
        fixture.officeId,
        fixture.existingCustomerId,
        fixture.phoneAId,
      )
      .all<{ status: string }>()
    expect(rows.results).toEqual([{ status: '완료' }])
  })

  it('rejects invalid recipients without leaving customer rows', async () => {
    const fixture = await seedFixture()
    const response = await startConversation(
      {
        officeChannelId: fixture.phoneAId,
        phone: '전화번호 아님',
      },
      fixture.token,
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: expect.stringContaining('010-1234-5678'),
      },
    })
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM customers
       WHERE office_id = ?`,
    )
      .bind(fixture.officeId)
      .first<{ count: number }>()
    expect(row?.count).toBe(1)
  })

  it('sends through the selected phone device', async () => {
    const fixture = await seedFixture()
    const start = await startConversation(
      {
        officeChannelId: fixture.phoneBId,
        phone: '010-9999-0000',
      },
      fixture.token,
    )
    const started = await start.json<ConversationStartResponse>()
    mockGateway(fixture.phoneBDeviceId)

    const response = await sendMessage(
      started.conversationId,
      fixture.token,
    )

    expect(response.status).toBe(201)
    expect(gatewayRequests).toEqual([
      {
        id: 'compose-selected-device',
        deviceId: fixture.phoneBDeviceId,
        textMessage: { text: '선택한 업무폰으로 보냅니다' },
        phoneNumbers: ['+821099990000'],
        simNumber: 1,
        withDeliveryReport: true,
      },
    ])
  })
})
