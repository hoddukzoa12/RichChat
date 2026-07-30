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
import type { MessageAttachment } from '../../shared/wire/message'
import type { SendMessageResponse } from '../../shared/wire/message-send'
import { applyDeliveryReports } from '../db/delivery'
import {
  gatewayDeliveryStatus,
  type GatewayState,
} from '../gateway/send'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import { LGU_SEND_TIMEOUT_MS } from '../lgu/send'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const LGU_SEND_ORIGIN = `https://${env.LGU_SEND_HOST}`
const LGU_CONTENT_ORIGIN = `https://${env.LGU_CONTENT_HOST}`
const SMS_GATEWAY_API_URL = new URL(env.SMS_GATEWAY_API_URL)
const SMS_GATEWAY_ORIGIN = SMS_GATEWAY_API_URL.origin
const SMS_GATEWAY_MESSAGES_PATH =
  `${SMS_GATEWAY_API_URL.pathname.replace(/\/+$/, '')}/messages`
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
  fileIdLst?: string[]
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
  channel?: 'SMS' | 'LMS' | 'MMS'
  clientKey: string
  data?: string | Record<string, unknown>
  delay?: number
  persistent?: boolean
  response?: (providerKey: string) => Record<string, unknown>
  status?: number
}

interface GatewayRequestBody {
  deviceId: string
  id: string
  phoneNumbers: string[]
  simNumber: number
  textMessage: { text: string }
  withDeliveryReport: boolean
}

interface MockGatewayOptions {
  deviceId: string
  error?: string
  state?: GatewayState
  status?: number
}

let seedSequence = 0
const lguRequests: LguRequestBody[] = []
const lguUploadRequests: string[] = []
const gatewayRequests: GatewayRequestBody[] = []

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterEach(() => {
  fetchMock.assertNoPendingInterceptors()
  lguRequests.length = 0
  lguUploadRequests.length = 0
  gatewayRequests.length = 0
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

async function uploadAttachment(
  fixture: Fixture,
  file = new File(
    [Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])],
    '답변.jpg',
    { type: 'image/jpeg' },
  ),
): Promise<MessageAttachment> {
  const form = new FormData()
  form.append('files', file)
  const response = await SELF.fetch(
    `${ORIGIN}/api/conversations/${fixture.conversationId}/attachments`,
    {
      method: 'POST',
      headers: {
        cookie: cookie(fixture.token),
        origin: ORIGIN,
      },
      body: form,
    },
  )
  const body = await response.json<{ attachments: MessageAttachment[] }>()
  expect(response.status).toBe(201)
  const attachment = body.attachments[0]
  if (!attachment) throw new Error('업로드한 첨부를 반환받지 못했습니다.')
  return attachment
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

function mockLguUpload(
  fileId: string,
  response: {
    code?: string
    message?: string
    status?: number
  } = {},
): void {
  fetchMock
    .get(LGU_CONTENT_ORIGIN)
    .intercept({
      method: 'POST',
      path: '/file/v1/mms',
      headers: {
        authorization: /^Bearer access-token-message-send-\d+$/,
        'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
      },
    })
    .reply(
      response.status ?? 200,
      () => {
        lguUploadRequests.push(fileId)
        return JSON.stringify({
          code: response.code ?? '10000',
          message: response.message ?? '성공',
          data:
            response.code === undefined || response.code === '10000'
              ? {
                  ch: 'mms',
                  imgUrl: null,
                  imgUrlLst: null,
                  fileId,
                  fileExpDt: '2027-07-29T00:00:00',
                }
              : null,
        })
      },
      { headers: { 'content-type': 'application/json' } },
    )
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

async function bindGatewayChannel(
  fixture: Fixture,
  deviceId: string,
  active = 1,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE office_channels
       SET device_id = ?, active = ?
       WHERE office_id = ?
         AND is_default = 1`,
    ).bind(deviceId, active, fixture.officeId),
    env.DB.prepare(
      `UPDATE conversations
       SET office_channel_id = (
         SELECT id
         FROM office_channels
         WHERE office_id = ?
           AND is_default = 1
       )
       WHERE id = ?`,
    ).bind(fixture.officeId, fixture.conversationId),
  ])
}

function mockGateway(options: MockGatewayOptions): void {
  const state = options.state ?? 'Processed'
  fetchMock
    .get(SMS_GATEWAY_ORIGIN)
    .intercept({
      method: 'POST',
      path: SMS_GATEWAY_MESSAGES_PATH,
      headers: {
        authorization:
          `Basic ${btoa('test-gateway-user:test-gateway-password')}`,
        'content-type': 'application/json',
        'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
      },
    })
    .reply(
      options.status ?? 200,
      ({ body }) => {
        const request = JSON.parse(String(body)) as GatewayRequestBody
        gatewayRequests.push(request)
        if (options.status && options.status >= 400) {
          return JSON.stringify({
            message: options.error ?? 'gateway request failed',
          })
        }
        return JSON.stringify({
          id: request.id,
          deviceId: options.deviceId,
          state,
          recipients: [
            {
              phoneNumber: request.phoneNumbers[0],
              state,
              error: options.error ?? null,
            },
          ],
        })
      },
      { headers: { 'content-type': 'application/json' } },
    )
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

  it('uses the conversation gateway device and client key exactly once', async () => {
    const fixture = await seedFixture()
    const clientKey = 'gateway-idempotency'
    const deviceId = 'gateway-device-idempotency'
    await bindGatewayChannel(fixture, deviceId)
    mockGateway({ deviceId })

    const first = await postMessage(
      fixture.conversationId,
      { clientKey, body: '업무폰으로 답장합니다' },
      fixture.token,
    )
    const second = await postMessage(
      fixture.conversationId,
      { clientKey, body: '업무폰으로 답장합니다' },
      fixture.token,
    )

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(gatewayRequests).toEqual([
      {
        id: clientKey,
        deviceId,
        textMessage: { text: '업무폰으로 답장합니다' },
        phoneNumbers: [fixture.customerPhone],
        simNumber: 1,
        withDeliveryReport: true,
      },
    ])
    await expect(storedMessages(fixture)).resolves.toEqual([
      expect.objectContaining({
        delivery_status: '접수',
        result_code: 'Processed',
        msg_key: null,
      }),
    ])
  })

  it('keeps the LGU path for a selected channel without a device', async () => {
    const fixture = await seedFixture()
    await env.DB.prepare(
      `UPDATE conversations
       SET office_channel_id = (
         SELECT id
         FROM office_channels
         WHERE office_id = ?
           AND is_default = 1
       )
       WHERE id = ?`,
    )
      .bind(fixture.officeId, fixture.conversationId)
      .run()
    mockLgu({ clientKey: 'selected-lgu-channel' })

    const response = await postMessage(
      fixture.conversationId,
      {
        clientKey: 'selected-lgu-channel',
        body: 'LGU+ 대표번호로 답장합니다',
      },
      fixture.token,
    )

    expect(response.status).toBe(201)
    expect(lguRequests).toHaveLength(1)
    expect(gatewayRequests).toEqual([])
  })

  it('maps gateway states and refuses a reverse transition', async () => {
    const cases: ReadonlyArray<{
      expected: string
      state: GatewayState
    }> = [
      { state: 'Pending', expected: '대기' },
      { state: 'Processed', expected: '접수' },
      { state: 'Sent', expected: '전송중' },
      { state: 'Delivered', expected: '완료' },
      { state: 'Failed', expected: '실패' },
    ]
    let deliveredFixture: Fixture | null = null
    let deliveredClientKey = ''

    for (const { state, expected } of cases) {
      const fixture = await seedFixture()
      const deviceId = `gateway-device-${state}`
      const clientKey = `gateway-state-${state}`
      await bindGatewayChannel(fixture, deviceId)
      mockGateway({
        deviceId,
        state,
        error: state === 'Failed' ? '업무폰 연결 끊김' : undefined,
      })

      const response = await postMessage(
        fixture.conversationId,
        { clientKey, body: `${state} 상태 확인` },
        fixture.token,
      )

      expect(response.status).toBe(201)
      await expect(storedMessages(fixture)).resolves.toEqual([
        expect.objectContaining({
          delivery_status: expected,
          error_text:
            state === 'Failed'
              ? expect.stringContaining('업무폰 연결 끊김')
              : null,
        }),
      ])
      if (state === 'Delivered') {
        deliveredFixture = fixture
        deliveredClientKey = clientKey
      }
    }

    if (deliveredFixture === null) {
      throw new Error('완료 상태 테스트 픽스처를 만들지 못했습니다.')
    }
    const reverse = await applyDeliveryReports(env.DB, [
      {
        clientKey: deliveredClientKey,
        deliveredAt: null,
        errorText: null,
        eventAt: Date.now(),
        msgKey: null,
        resultCode: 'Sent',
        status: gatewayDeliveryStatus('Sent'),
      },
    ])

    expect(reverse).toMatchObject({ changed: 0, unchanged: 1 })
    await expect(storedMessages(deliveredFixture)).resolves.toEqual([
      expect.objectContaining({ delivery_status: '완료' }),
    ])
  })

  it('stores a gateway HTTP error as a readable failure', async () => {
    const fixture = await seedFixture()
    const deviceId = 'gateway-device-http-error'
    await bindGatewayChannel(fixture, deviceId)
    mockGateway({
      deviceId,
      status: 503,
      error: '업무폰이 오프라인입니다.',
    })

    const response = await postMessage(
      fixture.conversationId,
      {
        clientKey: 'gateway-http-error',
        body: '실패 결과를 저장합니다',
      },
      fixture.token,
    )

    expect(response.status).toBe(201)
    await expect(storedMessages(fixture)).resolves.toEqual([
      expect.objectContaining({
        delivery_status: '실패',
        result_code: 'HTTP_503',
        error_text: expect.stringContaining('업무폰이 오프라인입니다.'),
      }),
    ])
  })

  it('rejects an inactive conversation channel before inserting', async () => {
    const fixture = await seedFixture()
    await bindGatewayChannel(
      fixture,
      'gateway-device-inactive',
      0,
    )

    const response = await postMessage(
      fixture.conversationId,
      {
        clientKey: 'gateway-inactive',
        body: '비활성 업무폰 발송',
      },
      fixture.token,
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('비활성') },
    })
    await expect(storedMessages(fixture)).resolves.toEqual([])
  })

  it('returns a readable conflict when no conversation channel exists', async () => {
    const fixture = await seedFixture({ callback: null })

    const response = await postMessage(
      fixture.conversationId,
      {
        clientKey: 'gateway-missing-channel',
        body: '채널 없는 대화 발송',
      },
      fixture.token,
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('업무폰') },
    })
    await expect(storedMessages(fixture)).resolves.toEqual([])
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

  it('uploads and sends one photo-only MMS once for a duplicate client key', async () => {
    const fixture = await seedFixture()
    const attachment = await uploadAttachment(fixture)
    const clientKey = 'mms-idempotency'
    mockLguUpload(attachment.id)
    mockLgu({
      accessToken: fixture.accessToken,
      channel: 'MMS',
      clientKey,
      persistent: true,
    })
    const request = {
      clientKey,
      body: '',
      attachments: [{ id: attachment.id }],
    }

    const [first, second] = await Promise.all([
      postMessage(fixture.conversationId, request, fixture.token),
      postMessage(fixture.conversationId, request, fixture.token),
    ])
    const firstBody = await first.json<SendMessageResponse>()
    const secondBody = await second.json<SendMessageResponse>()

    expect([first.status, second.status].sort()).toEqual([200, 201])
    expect(lguUploadRequests).toEqual([attachment.id])
    expect(lguRequests).toHaveLength(1)
    expect(lguRequests[0]).toMatchObject({
      msg: '',
      fileIdLst: [attachment.id],
    })
    expect(lguRequests[0]).not.toHaveProperty('title')
    await expect(storedMessages(fixture)).resolves.toEqual([
      expect.objectContaining({
        channel: 'MMS',
        delivery_status: '접수',
      }),
    ])
    expect(firstBody.message.attachments).toEqual([attachment])
    expect(secondBody.message.attachments).toEqual([attachment])
    const object = await env.ATTACHMENTS.head(
      `attachments/${attachment.id}`,
    )
    expect(object?.size).toBe(attachment.byteSize)

    const pageResponse = await SELF.fetch(
      `${ORIGIN}${messagePath(fixture.conversationId)}`,
      { headers: { cookie: cookie(fixture.token) } },
    )
    const page = await pageResponse.json<{
      messages: Array<{ attachments: MessageAttachment[] }>
    }>()
    expect(page.messages[0]?.attachments).toEqual([attachment])
  })

  it('does not call the send API when an attachment upload fails', async () => {
    const fixture = await seedFixture()
    const attachment = await uploadAttachment(fixture)
    mockLguUpload(attachment.id, {
      code: '21006',
      message: '첨부파일 확장자 오류',
      status: 400,
    })

    const response = await postMessage(
      fixture.conversationId,
      {
        clientKey: 'mms-upload-failure',
        body: '사진을 확인해 주세요',
        attachments: [{ id: attachment.id }],
      },
      fixture.token,
    )

    expect(response.status).toBe(201)
    expect(lguUploadRequests).toEqual([attachment.id])
    expect(lguRequests).toEqual([])
    await expect(storedMessages(fixture)).resolves.toEqual([
      expect.objectContaining({
        channel: 'MMS',
        delivery_status: '실패',
        result_code: '21006',
        error_text: expect.stringContaining('첨부 업로드'),
      }),
    ])
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

  it('rejects an unknown attachment and emoji before inserting', async () => {
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
      error: { code: 'BAD_REQUEST' },
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
