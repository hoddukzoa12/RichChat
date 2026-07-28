import { env, fetchMock, SELF } from 'cloudflare:test'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest'
import type { Status } from '../../shared/domain'
import type { SendMessageResponse } from '../../shared/wire/message-send'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import { LGU_SEND_TIMEOUT_MS } from '../lgu/send'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const LGU_SEND_ORIGIN = 'https://api-send.msghub-qa.uplus.co.kr'
const DEFAULT_CALLBACK = '0255550000'

interface Fixture {
  accessToken: string
  actorId: string
  callback: string | null
  conversationId: string
  customerPhone: string
  officeId: string
  otherUserId: string
  token: string
}

interface FixtureOptions {
  assigned?: boolean
  callback?: string | null
  status?: Status
}

interface StoredMessage {
  id: string
  channel: string
  delivery_status: string
  result_code: string | null
  error_text: string | null
  msg_key: string | null
}

interface LguRequestBody {
  apiKey?: string
  callback: string
  msg: string
  recvInfoLst: Array<{
    cliKey: string
    phone: string
    countryCd: string
    mergeData: Record<string, unknown>
  }>
}

interface MockLguOptions {
  accessToken?: string
  channel?: 'SMS' | 'LMS'
  clientKey: string
  data?: string | Record<string, unknown>
  delay?: number
  persistent?: boolean
  response?: (providerKey: string) => Record<string, unknown>
  status?: number
}

let seedSequence = 0
const lguRequests: LguRequestBody[] = []

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterEach(() => {
  fetchMock.assertNoPendingInterceptors()
  lguRequests.length = 0
})

afterAll(() => {
  fetchMock.deactivate()
})

async function seedFixture(
  options: FixtureOptions = {},
): Promise<Fixture> {
  seedSequence += 1
  const suffix = `message-send-${seedSequence}`
  const officeId = `office-${suffix}`
  const actorId = `actor-${suffix}`
  const otherUserId = `other-${suffix}`
  const customerId = `customer-${suffix}`
  const conversationId = `conversation-${suffix}`
  const customerPhone = `+8210${String(seedSequence).padStart(8, '0')}`
  const accessToken = `access-token-${suffix}`
  const callback =
    options.callback === undefined ? DEFAULT_CALLBACK : options.callback
  const now = Date.now()

  const statements: D1PreparedStatement[] = [
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
        index === 0 ? '박상담' : '김세무',
        index === 0 ? '상담 담당' : '세무사',
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
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      conversationId,
      officeId,
      customerId,
      options.status ?? '미처리',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO lgu_tokens (
         office_id, access_token, issued_at, expires_at, lease_until
       ) VALUES (?, ?, ?, ?, 0)`,
    ).bind(
      officeId,
      accessToken,
      now,
      now + 60 * 60 * 1_000,
    ),
  ]

  if (callback !== null) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO office_channels (
           id, office_id, value, label, is_default, active, created_at
         ) VALUES (?, ?, ?, '', 1, 1, ?)`,
      ).bind(
        `channel-${suffix}`,
        officeId,
        callback,
        now,
      ),
    )
  }

  if (options.assigned) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO conversation_assignees (
           conversation_id, office_id, user_id, assigned_at, assigned_by
         ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        conversationId,
        officeId,
        otherUserId,
        now,
        otherUserId,
      ),
    )
  }

  await env.DB.batch(statements)
  const session = await createSession(
    env.DB,
    { userId: actorId, officeId },
    now,
  )

  return {
    accessToken,
    actorId,
    callback,
    conversationId,
    customerPhone,
    officeId,
    otherUserId,
    token: session.token,
  }
}

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

function localPhone(phoneE164: string): string {
  return `0${phoneE164.slice(3)}`
}

function messagePath(conversationId: string): string {
  return `/api/conversations/${conversationId}/messages`
}

function postMessage(
  conversationId: string,
  input: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  const headers = new Headers({
    origin: ORIGIN,
    'content-type': 'application/json',
  })
  if (token) headers.set('cookie', cookie(token))

  return SELF.fetch(`${ORIGIN}${messagePath(conversationId)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  })
}

function acceptedResponse(
  providerKey: string,
  msgKey: string,
): Record<string, unknown> {
  return {
    code: '10000',
    message: '성공',
    data: [
      {
        cliKey: providerKey,
        msgKey,
        phone: '01000000000',
        code: '10000',
        message: '성공',
      },
    ],
  }
}

function mockLgu(options: MockLguOptions): void {
  const channel = options.channel ?? 'SMS'
  const path = channel === 'SMS' ? '/msg/v1/sms' : '/msg/v1/mms'
  const scope = fetchMock
    .get(LGU_SEND_ORIGIN)
    .intercept({
      method: 'POST',
      path,
      headers: {
        authorization: options.accessToken
          ? `Bearer ${options.accessToken}`
          : /^Bearer access-token-message-send-\d+$/,
        'content-type': 'application/json',
      },
      body: (raw) =>
        (JSON.parse(raw) as LguRequestBody).recvInfoLst.length === 1,
    })
    .reply(
      options.status ?? 200,
      ({ body }) => {
        const parsed = JSON.parse(String(body)) as LguRequestBody
        lguRequests.push(parsed)
        const providerKey = parsed.recvInfoLst[0]?.cliKey ?? ''
        return typeof options.data === 'string'
          ? options.data
          : JSON.stringify(
              options.response?.(providerKey) ??
                options.data ??
                acceptedResponse(
                  providerKey,
                  `lgu-${options.clientKey}`,
                ),
            )
      },
      { headers: { 'content-type': 'application/json' } },
    )

  if (options.delay !== undefined) scope.delay(options.delay)
  if (options.persistent) scope.persist()
}

function mockNetworkFailure(): void {
  fetchMock
    .get(LGU_SEND_ORIGIN)
    .intercept({
      method: 'POST',
      path: '/msg/v1/sms',
      body: (raw) =>
        (JSON.parse(raw) as LguRequestBody).recvInfoLst.length === 1,
    })
    .replyWithError(new TypeError('connection reset'))
}

async function storedMessages(
  fixture: Fixture,
): Promise<StoredMessage[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       id, channel, delivery_status, result_code, error_text, msg_key
     FROM messages
     WHERE office_id = ?
     ORDER BY created_at, id`,
  )
    .bind(fixture.officeId)
    .all<StoredMessage>()
  return results
}

async function assignees(fixture: Fixture): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT user_id
     FROM conversation_assignees
     WHERE conversation_id = ?
     ORDER BY user_id`,
  )
    .bind(fixture.conversationId)
    .all<{ user_id: string }>()
  return results.map((row) => row.user_id)
}

async function conversation(
  fixture: Fixture,
): Promise<{
  last_message_id: string | null
  last_message_at: number | null
  status: Status
}> {
  const row = await env.DB.prepare(
    `SELECT status, last_message_id, last_message_at
     FROM conversations
     WHERE id = ?`,
  )
    .bind(fixture.conversationId)
    .first<{
      last_message_id: string | null
      last_message_at: number | null
      status: Status
    }>()
  if (!row) throw new Error('테스트 대화를 찾을 수 없습니다.')
  return row
}

async function eventTypes(fixture: Fixture): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT type
     FROM events
     WHERE office_id = ?
     ORDER BY office_seq`,
  )
    .bind(fixture.officeId)
    .all<{ type: string }>()
  return results.map((row) => row.type)
}

describe('Message send route', () => {
  it('requires a session cookie', async () => {
    const response = await postMessage('missing', {
      clientKey: 'without-session',
      body: '안녕하세요',
    })

    expect(response.status).toBe(401)
  })

  it('inserts and calls LGU+ exactly once for duplicate client keys', async () => {
    const fixture = await seedFixture()
    const clientKey = 'c6176dc3-08bc-4e81-b373-4683be50b64e'
    mockLgu({
      accessToken: fixture.accessToken,
      clientKey,
      persistent: true,
    })

    const first = await postMessage(
      fixture.conversationId,
      { clientKey, body: '안녕하세요' },
      fixture.token,
    )
    const second = await postMessage(
      fixture.conversationId,
      { clientKey, body: '안녕하세요' },
      fixture.token,
    )

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(lguRequests).toHaveLength(1)
    expect(await storedMessages(fixture)).toHaveLength(1)
    await expect(second.json<SendMessageResponse>()).resolves.toMatchObject({
      clientKey,
      message: {
        deliveryStatus: '접수',
        resultCode: '10000',
      },
    })
    await expect(eventTypes(fixture)).resolves.toEqual([
      'message.created',
      'message.delivery_updated',
    ])
  })

  it('serializes concurrent duplicate requests before calling LGU+', async () => {
    const fixture = await seedFixture()
    const clientKey = 'concurrent-idempotency'
    mockLgu({
      accessToken: fixture.accessToken,
      clientKey,
      delay: 50,
      persistent: true,
    })

    const responses = await Promise.all([
      postMessage(
        fixture.conversationId,
        { clientKey, body: '동시 발송 요청' },
        fixture.token,
      ),
      postMessage(
        fixture.conversationId,
        { clientKey, body: '동시 발송 요청' },
        fixture.token,
      ),
    ])

    expect(responses.every((response) => response.ok)).toBe(true)
    expect(lguRequests).toHaveLength(1)
    expect(await storedMessages(fixture)).toHaveLength(1)
  })

  it('selects SMS at 90 EUC-KR bytes and LMS at 92 bytes', async () => {
    const fixture = await seedFixture()
    mockLgu({ clientKey: 'sms-boundary' })
    mockLgu({ clientKey: 'lms-boundary', channel: 'LMS' })

    const sms = await postMessage(
      fixture.conversationId,
      { clientKey: 'sms-boundary', body: '가'.repeat(45) },
      fixture.token,
    )
    const lms = await postMessage(
      fixture.conversationId,
      { clientKey: 'lms-boundary', body: '가'.repeat(46) },
      fixture.token,
    )

    expect(sms.status).toBe(201)
    expect(lms.status).toBe(201)
    expect(
      (await storedMessages(fixture)).map((message) => message.channel),
    ).toEqual(['SMS', 'LMS'])
  })

  it('rejects over 2000 EUC-KR bytes before inserting', async () => {
    const fixture = await seedFixture()
    const response = await postMessage(
      fixture.conversationId,
      { clientKey: 'too-long', body: '가'.repeat(1_001) },
      fixture.token,
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'MSG_TOO_LONG' },
    })
    await expect(storedMessages(fixture)).resolves.toEqual([])
  })

  it('transitions first and completed replies to doing and auto-assigns the sender', async () => {
    for (const status of ['미처리', '완료'] as const) {
      const fixture = await seedFixture({ status })
      const clientKey =
        status === '미처리' ? 'transition-open' : 'transition-completed'
      mockLgu({ clientKey })

      const response = await postMessage(
        fixture.conversationId,
        { clientKey, body: '답장드립니다' },
        fixture.token,
      )

      expect(response.status).toBe(201)
      await expect(conversation(fixture)).resolves.toMatchObject({
        status: '처리중',
      })
      await expect(assignees(fixture)).resolves.toEqual([
        fixture.actorId,
      ])
    }
  })

  it('keeps the existing assignee on an active conversation', async () => {
    const fixture = await seedFixture({
      assigned: true,
      status: '처리중',
    })
    mockLgu({ clientKey: 'keep-assignee' })

    const response = await postMessage(
      fixture.conversationId,
      { clientKey: 'keep-assignee', body: '기존 담당자가 있습니다' },
      fixture.token,
    )

    expect(response.status).toBe(201)
    await expect(assignees(fixture)).resolves.toEqual([
      fixture.otherUserId,
    ])
  })

  it('ignores a client callback and sends the configured default callback', async () => {
    const fixture = await seedFixture()
    mockLgu({ clientKey: 'server-callback' })

    const response = await postMessage(
      fixture.conversationId,
      {
        clientKey: 'server-callback',
        body: '서버 발신번호 사용',
        callback: '01099998888',
      },
      fixture.token,
    )

    expect(response.status).toBe(201)
    expect(lguRequests).toHaveLength(1)
    expect(lguRequests[0]).toMatchObject({
      callback: DEFAULT_CALLBACK,
      recvInfoLst: [
        {
          phone: localPhone(fixture.customerPhone),
          countryCd: '82',
        },
      ],
    })
    expect(lguRequests[0].recvInfoLst[0]?.cliKey).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{26}$/,
    )
    expect(lguRequests[0].recvInfoLst[0]?.cliKey).not.toBe(
      'server-callback',
    )
  })

  it('rejects before inserting when no active default callback exists', async () => {
    const fixture = await seedFixture({ callback: null })
    const response = await postMessage(
      fixture.conversationId,
      { clientKey: 'no-callback', body: '발신번호 없음' },
      fixture.token,
    )

    expect(response.status).toBe(409)
    await expect(storedMessages(fixture)).resolves.toEqual([])
  })

  it('stores a confirmed LGU+ rejection as failed with its reason', async () => {
    const fixture = await seedFixture()
    const clientKey = 'provider-rejection'
    mockLgu({
      clientKey,
      response: (providerKey) => ({
        code: '10000',
        message: '접수 결과',
        data: [
          {
            cliKey: providerKey,
            code: '40017',
            message: 'invalid callback',
          },
        ],
      }),
    })

    const response = await postMessage(
      fixture.conversationId,
      { clientKey, body: '거절될 메시지' },
      fixture.token,
    )

    expect(response.status).toBe(201)
    await expect(storedMessages(fixture)).resolves.toEqual([
      expect.objectContaining({
        delivery_status: '실패',
        result_code: '40017',
        error_text: expect.stringContaining('invalid callback'),
        msg_key: null,
      }),
    ])
    await expect(eventTypes(fixture)).resolves.toEqual([
      'message.created',
      'message.delivery_updated',
    ])
  })

  it('keeps a delayed response pending because acceptance is uncertain', async () => {
    const fixture = await seedFixture()
    const clientKey = 'timeout-uncertain'
    mockLgu({
      clientKey,
      delay: LGU_SEND_TIMEOUT_MS + 100,
    })

    const response = await postMessage(
      fixture.conversationId,
      { clientKey, body: '응답 지연' },
      fixture.token,
    )

    expect(response.status).toBe(201)
    await expect(storedMessages(fixture)).resolves.toEqual([
      expect.objectContaining({
        delivery_status: '대기',
        result_code: null,
        error_text: null,
        msg_key: null,
      }),
    ])
    await expect(eventTypes(fixture)).resolves.toEqual([
      'message.created',
    ])
  }, LGU_SEND_TIMEOUT_MS + 5_000)

  it('keeps network, 5xx, and malformed responses pending', async () => {
    const networkFixture = await seedFixture()
    mockNetworkFailure()
    const network = await postMessage(
      networkFixture.conversationId,
      { clientKey: 'network-uncertain', body: '네트워크 실패' },
      networkFixture.token,
    )

    const serverErrorFixture = await seedFixture()
    mockLgu({
      clientKey: 'server-error-uncertain',
      status: 503,
      data: {
        code: '50001',
        message: 'temporarily unavailable',
      },
    })
    const serverError = await postMessage(
      serverErrorFixture.conversationId,
      { clientKey: 'server-error-uncertain', body: '서버 오류' },
      serverErrorFixture.token,
    )

    const malformedFixture = await seedFixture()
    mockLgu({
      clientKey: 'malformed-uncertain',
      data: 'not-json',
    })
    const malformed = await postMessage(
      malformedFixture.conversationId,
      { clientKey: 'malformed-uncertain', body: '파싱 실패' },
      malformedFixture.token,
    )

    expect(network.status).toBe(201)
    expect(serverError.status).toBe(201)
    expect(malformed.status).toBe(201)
    expect((await storedMessages(networkFixture))[0]).toMatchObject({
      delivery_status: '대기',
    })
    expect((await storedMessages(serverErrorFixture))[0]).toMatchObject({
      delivery_status: '대기',
    })
    expect((await storedMessages(malformedFixture))[0]).toMatchObject({
      delivery_status: '대기',
    })
  })

  it('rejects attachments and emoji with dedicated codes', async () => {
    const fixture = await seedFixture()

    const attachment = await postMessage(
      fixture.conversationId,
      {
        clientKey: 'attachment-rejected',
        body: '파일도 보냅니다',
        attachments: [{ id: 'attachment-1' }],
      },
      fixture.token,
    )
    const emoji = await postMessage(
      fixture.conversationId,
      { clientKey: 'emoji-rejected', body: '확인했습니다 😀' },
      fixture.token,
    )

    expect(attachment.status).toBe(400)
    await expect(attachment.json()).resolves.toMatchObject({
      error: { code: 'MSG_ATTACHMENTS_UNSUPPORTED' },
    })
    expect(emoji.status).toBe(400)
    await expect(emoji.json()).resolves.toMatchObject({
      error: { code: 'MSG_EMOJI_UNSUPPORTED' },
    })
    await expect(storedMessages(fixture)).resolves.toEqual([])
  })

  it('leaves the pending row recoverable when the result batch fails', async () => {
    const fixture = await seedFixture()
    const clientKey = 'result-batch-failure'
    await env.DB.prepare(
      `CREATE TRIGGER fail_send_result
       BEFORE UPDATE OF delivery_status ON messages
       WHEN OLD.client_key = 'result-batch-failure'
         AND NEW.delivery_status = '접수'
       BEGIN
         SELECT RAISE(FAIL, 'forced result failure');
       END`,
    ).run()
    mockLgu({ clientKey })

    try {
      const response = await postMessage(
        fixture.conversationId,
        { clientKey, body: '결과 저장 실패' },
        fixture.token,
      )

      expect(response.status).toBe(500)
      await expect(storedMessages(fixture)).resolves.toEqual([
        expect.objectContaining({
          delivery_status: '대기',
          result_code: null,
          msg_key: null,
        }),
      ])
      await expect(eventTypes(fixture)).resolves.toEqual([
        'message.created',
      ])
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_send_result').run()
    }
  })

  it('stores provider acceptance as accepted rather than delivered', async () => {
    const fixture = await seedFixture()
    mockLgu({ clientKey: 'accepted-not-delivered' })

    const response = await postMessage(
      fixture.conversationId,
      {
        clientKey: 'accepted-not-delivered',
        body: '접수 상태 확인',
      },
      fixture.token,
    )
    const result = await response.json<SendMessageResponse>()

    expect(response.status).toBe(201)
    expect(result.message.deliveryStatus).toBe('접수')
    expect(result.message.deliveredAt).toBeNull()
  })

  it('does not move the last message pointer backward', async () => {
    const fixture = await seedFixture()
    const future = Date.now() + 60_000
    const existingId = `future-message-${seedSequence}`
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (
           id, office_id, conversation_id, direction, channel, title, body,
           sender_user_id, occurred_at, created_at, mo_key, client_key,
           msg_key, delivery_status
         ) VALUES (
           ?, ?, ?, 'in', 'SMS', NULL, '미래 시각 수신', NULL, ?, ?, ?,
           NULL, NULL, '수신'
         )`,
      ).bind(
        existingId,
        fixture.officeId,
        fixture.conversationId,
        future,
        future,
        `mo-future-${seedSequence}`,
      ),
      env.DB.prepare(
        `UPDATE conversations
         SET last_message_id = ?, last_message_at = ?
         WHERE id = ?`,
      ).bind(existingId, future, fixture.conversationId),
    ])
    mockLgu({ clientKey: 'older-outbound' })

    const response = await postMessage(
      fixture.conversationId,
      { clientKey: 'older-outbound', body: '시계가 뒤로 간 발송' },
      fixture.token,
    )

    expect(response.status).toBe(201)
    await expect(conversation(fixture)).resolves.toMatchObject({
      last_message_id: existingId,
      last_message_at: future,
    })
  })
})
