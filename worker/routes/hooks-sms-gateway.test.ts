import { env, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import {
  TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID,
  TEST_SMS_GATEWAY_SECONDARY_DEVICE_ID,
  TEST_SMS_GATEWAY_SIGNING_KEYS,
} from '../../tests/sms-gateway-fixtures'
import {
  createSmsGatewayWebhookHandler,
  smsGatewayIdempotencyKey,
  WEBHOOK_TIMESTAMP_WINDOW_MS,
} from './hooks-sms-gateway'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const HOOK_URL = `${ORIGIN}/api/hooks/sms-gateway`
const OFFICE_ID = 'office-sms-gateway'
const DEVICE_ID = TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID
const SECOND_DEVICE_ID = TEST_SMS_GATEWAY_SECONDARY_DEVICE_ID

interface PayloadOverrides {
  messageId?: string
  message?: string
  sender?: string
  recipient?: string | null
  simNumber?: number | null
  receivedAt?: string
}

function webhookBody(
  overrides: PayloadOverrides = {},
  envelopeId = 'delivery-1',
  deviceId = DEVICE_ID,
): string {
  return JSON.stringify({
    deviceId,
    event: 'sms:received',
    id: envelopeId,
    webhookId: 'webhook-1',
    payload: {
      messageId: overrides.messageId ?? 'gateway-message-1',
      message: overrides.message ?? '부가세 문의드려요',
      sender: overrides.sender ?? '01022334455',
      recipient:
        overrides.recipient === undefined
          ? '01099998888'
          : overrides.recipient,
      simNumber:
        overrides.simNumber === undefined ? 1 : overrides.simNumber,
      receivedAt:
        overrides.receivedAt ??
        '2026-07-30T14:00:00.000+09:00',
    },
  })
}

async function signature(
  body: string,
  timestamp: string,
): Promise<string> {
  const { deviceId } = JSON.parse(body) as { deviceId: string }
  const signingKey =
    TEST_SMS_GATEWAY_SIGNING_KEYS[
      deviceId as keyof typeof TEST_SMS_GATEWAY_SIGNING_KEYS
    ]
  if (signingKey === undefined) {
    throw new Error('테스트 기기의 서명키를 찾지 못했습니다.')
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${body}${timestamp}`),
    ),
  )
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function post(
  body: string,
  options: {
    timestamp?: string
    signature?: string
  } = {},
): Promise<Response> {
  const timestamp =
    options.timestamp ?? String(Math.floor(Date.now() / 1_000))
  return SELF.fetch(HOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature':
        options.signature ?? (await signature(body, timestamp)),
      'x-timestamp': timestamp,
    },
    body,
  })
}

async function insertOfficeChannels(
  deviceIds: readonly string[] = [DEVICE_ID],
): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(OFFICE_ID, '세무법인 리치', now),
    ...deviceIds.map((deviceId, index) =>
      env.DB
        .prepare(
          `INSERT INTO office_channels (
             id, office_id, value, label, is_default, active, created_at,
             device_id
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          `channel-sms-gateway-${index + 1}`,
          OFFICE_ID,
          `0109999888${index}`,
          `업무폰 ${index + 1}`,
          index === 0 ? 1 : 0,
          now,
          deviceId,
        ),
    ),
  ])
}

async function expectSuccess(response: Response): Promise<void> {
  expect(response.status).toBe(204)
  await expect(response.text()).resolves.toBe('')
}

function kstTimestamp(epoch = Date.now()): string {
  return new Date(epoch + 9 * 60 * 60 * 1_000)
    .toISOString()
    .replace(/\D/g, '')
    .slice(0, 14)
}

function lguBody(moKey: string): string {
  return JSON.stringify({
    moCnt: 1,
    moLst: [
      {
        moKey,
        moNumber: '15445367',
        moType: 'SMSMO',
        moCallback: '01022334455',
        moMsg: 'LGU+에서 받은 문의',
        moRecvDt: kstTimestamp(),
        contentInfoLst: null,
      },
    ],
  })
}

describe('Android SMS Gateway webhook', () => {
  it('distinguishes malformed JSON from authentication failure', async () => {
    const response = await SELF.fetch(HOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': '0'.repeat(64),
        'x-timestamp': String(Math.floor(Date.now() / 1_000)),
      },
      body: '{',
    })

    expect(response.status).toBe(400)
  })

  it('rejects an invalid signature and accepts a valid signature', async () => {
    await insertOfficeChannels()
    const body = webhookBody()
    const noDatabaseEnv = {
      SMS_GATEWAY_SIGNING_KEYS: env.SMS_GATEWAY_SIGNING_KEYS,
      get DB(): never {
        throw new Error('인증 전에 D1에 접근했습니다.')
      },
    } as unknown as Env
    const handler = createSmsGatewayWebhookHandler()
    const timestamp = String(Math.floor(Date.now() / 1_000))

    const rejected = await handler(
      new Request(HOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': '0'.repeat(64),
          'x-timestamp': timestamp,
        },
        body,
      }),
      noDatabaseEnv,
      {},
    )
    expect(rejected.status).toBe(401)

    await expectSuccess(await post(body))
    const message = await env.DB.prepare(
      'SELECT body FROM messages WHERE mo_key = ?',
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, 'gateway-message-1'))
      .first<{ body: string }>()
    expect(message?.body).toBe('부가세 문의드려요')
  })

  it('stores matching messageIds from devices with distinct signing keys', async () => {
    await insertOfficeChannels([DEVICE_ID, SECOND_DEVICE_ID])
    const messageId = 'cross-device-message-id'
    const first = webhookBody(
      { messageId },
      'delivery-device-1',
      DEVICE_ID,
    )
    const second = webhookBody(
      { messageId },
      'delivery-device-2',
      SECOND_DEVICE_ID,
    )

    await expectSuccess(await post(first))
    await expectSuccess(await post(second))

    const { results } = await env.DB.prepare(
      `SELECT mo_key
       FROM messages
       WHERE office_id = ?
       ORDER BY mo_key`,
    )
      .bind(OFFICE_ID)
      .all<{ mo_key: string }>()
    expect(results.map(({ mo_key }) => mo_key)).toEqual(
      [
        smsGatewayIdempotencyKey(DEVICE_ID, messageId),
        smsGatewayIdempotencyKey(SECOND_DEVICE_ID, messageId),
      ].sort(),
    )
  })

  it('separates LGU+ keys and preserves LGU+ failure quarantine', async () => {
    await insertOfficeChannels()
    const sharedProviderKey = 'cross-provider-message-id'
    const lguResponse = await SELF.fetch(
      `${ORIGIN}/api/hooks/lgu/mo/${env.LGU_MO_WEBHOOK_SECRET}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: lguBody(sharedProviderKey),
      },
    )
    expect(lguResponse.status).toBe(200)

    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO mo_failures (
         mo_key, raw_json, error_text, attempts, first_at, last_at
       ) VALUES (?, '{}', '격리 유지 검증', 2, ?, ?)`,
    )
      .bind(sharedProviderKey, now, now)
      .run()

    await expectSuccess(
      await post(
        webhookBody({
          messageId: sharedProviderKey,
          message: '업무폰에서 받은 문의',
        }),
      ),
    )

    const { results } = await env.DB.prepare(
      `SELECT mo_key
       FROM messages
       WHERE office_id = ?
       ORDER BY mo_key`,
    )
      .bind(OFFICE_ID)
      .all<{ mo_key: string }>()
    expect(results.map(({ mo_key }) => mo_key)).toEqual(
      [
        sharedProviderKey,
        smsGatewayIdempotencyKey(DEVICE_ID, sharedProviderKey),
      ].sort(),
    )
    const failure = await env.DB.prepare(
      'SELECT attempts FROM mo_failures WHERE mo_key = ?',
    )
      .bind(sharedProviderKey)
      .first<{ attempts: number }>()
    expect(failure?.attempts).toBe(2)
  })

  it('rejects a correctly signed stale timestamp', async () => {
    await insertOfficeChannels()
    const body = webhookBody()
    const staleTimestamp = String(
      Math.floor(
        (Date.now() - WEBHOOK_TIMESTAMP_WINDOW_MS - 1_000) / 1_000,
      ),
    )

    const response = await post(body, {
      timestamp: staleTimestamp,
    })
    expect(response.status).toBe(401)

    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages',
    ).first<{ count: number }>()
    expect(messageCount?.count).toBe(0)
  })

  it('deduplicates by payload messageId when envelope ids differ', async () => {
    await insertOfficeChannels()
    const first = webhookBody({}, 'delivery-first')
    const replay = webhookBody({}, 'delivery-replay')

    await expectSuccess(await post(first))
    await expectSuccess(await post(replay))

    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE mo_key = ?',
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, 'gateway-message-1'))
      .first<{ count: number }>()
    const conversation = await env.DB.prepare(
      `SELECT inbound_count
       FROM conversations
       WHERE office_id = ?`,
    )
      .bind(OFFICE_ID)
      .first<{ inbound_count: number }>()
    expect(messageCount?.count).toBe(1)
    expect(conversation?.inbound_count).toBe(1)
  })

  it('uses deviceId when recipient is null and honors timestamp offsets', async () => {
    await insertOfficeChannels()
    const plusSeven = webhookBody({
      messageId: 'gateway-offset-plus-seven',
      recipient: null,
      simNumber: null,
      receivedAt: '2026-07-30T14:00:00.000+07:00',
    })
    const plusNine = webhookBody({
      messageId: 'gateway-offset-plus-nine',
      recipient: null,
      receivedAt: '2026-07-30T14:00:00.000+09:00',
    })

    await expectSuccess(await post(plusSeven))
    await expectSuccess(await post(plusNine))

    const { results } = await env.DB.prepare(
      `SELECT mo_key, occurred_at
       FROM messages
       WHERE office_id = ?
       ORDER BY mo_key`,
    )
      .bind(OFFICE_ID)
      .all<{ mo_key: string; occurred_at: number }>()
    expect(results).toEqual([
      {
        mo_key: smsGatewayIdempotencyKey(
          DEVICE_ID,
          'gateway-offset-plus-nine',
        ),
        occurred_at: Date.UTC(2026, 6, 30, 5),
      },
      {
        mo_key: smsGatewayIdempotencyKey(
          DEVICE_ID,
          'gateway-offset-plus-seven',
        ),
        occurred_at: Date.UTC(2026, 6, 30, 7),
      },
    ])
  })

  it('acknowledges unsupported events without storing them', async () => {
    const body = JSON.stringify({
      deviceId: DEVICE_ID,
      event: 'system:ping',
      id: 'ping-1',
      webhookId: 'webhook-1',
      payload: { health: 'pass' },
    })

    await expectSuccess(await post(body))
    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages',
    ).first<{ count: number }>()
    expect(messageCount?.count).toBe(0)
  })

  it('reopens a completed conversation', async () => {
    await insertOfficeChannels()
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO customers (
           id, office_id, phone_e164, name, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        'customer-completed',
        OFFICE_ID,
        '+821022334455',
        '완료 고객',
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO conversations (
           id, office_id, customer_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, '완료', ?, ?)`,
      ).bind(
        'conversation-completed',
        OFFICE_ID,
        'customer-completed',
        now,
        now,
      ),
    ])

    await expectSuccess(await post(webhookBody()))

    const conversation = await env.DB.prepare(
      `SELECT status, inbound_count
       FROM conversations
       WHERE id = 'conversation-completed'`,
    ).first<{ status: string; inbound_count: number }>()
    expect(conversation).toEqual({
      status: '미처리',
      inbound_count: 1,
    })
  })

  it('returns a retryable response for an unknown device', async () => {
    const failure = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    const response = await post(webhookBody())

    expect(response.status).toBe(503)
    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages',
    ).first<{ count: number }>()
    expect(messageCount?.count).toBe(0)
    failure.mockRestore()
  })

  it('does not acknowledge before the D1 commit succeeds', async () => {
    await insertOfficeChannels()
    await env.DB.prepare(
      `CREATE TRIGGER fail_gateway_message
       BEFORE INSERT ON messages
       BEGIN
         SELECT RAISE(FAIL, 'forced test failure');
       END`,
    ).run()
    const failure = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})

    const response = await post(webhookBody())

    expect(response.status).toBe(500)
    const message = await env.DB.prepare(
      'SELECT id FROM messages WHERE mo_key = ?',
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, 'gateway-message-1'))
      .first<{ id: string }>()
    expect(message).toBeNull()
    failure.mockRestore()
  })
})
