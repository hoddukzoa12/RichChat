import { env, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { WEBHOOK_TIMESTAMP_WINDOW_MS } from './hooks-sms-gateway'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const HOOK_URL = `${ORIGIN}/api/hooks/sms-gateway`
const DEVICE_ID = 'android-device-1'
const OFFICE_ID = 'office-sms-gateway'
const CHANNEL_ID = 'channel-sms-gateway'

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
): string {
  return JSON.stringify({
    deviceId: DEVICE_ID,
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
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SMS_GATEWAY_SIGNING_KEY),
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

async function insertOfficeChannel(
  deviceId = DEVICE_ID,
): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(OFFICE_ID, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO office_channels (
         id, office_id, value, label, is_default, active, created_at,
         device_id
       ) VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
    ).bind(
      CHANNEL_ID,
      OFFICE_ID,
      '01099998888',
      '업무폰 1',
      now,
      deviceId,
    ),
  ])
}

async function expectSuccess(response: Response): Promise<void> {
  expect(response.status).toBe(204)
  await expect(response.text()).resolves.toBe('')
}

describe('Android SMS Gateway webhook', () => {
  it('rejects an invalid signature and accepts a valid signature', async () => {
    await insertOfficeChannel()
    const body = webhookBody()

    const rejected = await post(body, {
      signature: '0'.repeat(64),
    })
    expect(rejected.status).toBe(401)

    await expectSuccess(await post(body))
    const message = await env.DB.prepare(
      'SELECT body FROM messages WHERE mo_key = ?',
    )
      .bind('gateway-message-1')
      .first<{ body: string }>()
    expect(message?.body).toBe('부가세 문의드려요')
  })

  it('rejects a correctly signed stale timestamp', async () => {
    await insertOfficeChannel()
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
    await insertOfficeChannel()
    const first = webhookBody({}, 'delivery-first')
    const replay = webhookBody({}, 'delivery-replay')

    await expectSuccess(await post(first))
    await expectSuccess(await post(replay))

    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE mo_key = ?',
    )
      .bind('gateway-message-1')
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
    await insertOfficeChannel()
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
        mo_key: 'gateway-offset-plus-nine',
        occurred_at: Date.UTC(2026, 6, 30, 5),
      },
      {
        mo_key: 'gateway-offset-plus-seven',
        occurred_at: Date.UTC(2026, 6, 30, 7),
      },
    ])
  })

  it('acknowledges unsupported events without storing them', async () => {
    const body = JSON.stringify({
      deviceId: 'unregistered-device',
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
    await insertOfficeChannel()
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
    await insertOfficeChannel()
    await env.DB.prepare(
      `CREATE TRIGGER fail_gateway_message
       BEFORE INSERT ON messages
       WHEN NEW.mo_key = 'gateway-message-1'
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
      .bind('gateway-message-1')
      .first<{ id: string }>()
    expect(message).toBeNull()
    failure.mockRestore()
  })
})
