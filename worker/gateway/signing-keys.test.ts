import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { smsGatewayWebhookEnv } from '../index'
import { createSmsGatewayWebhookHandler } from '../routes/hooks-sms-gateway'
import {
  legacySigningKeysForWebhook,
  parseSigningKeys,
  signingKeyForDevice,
} from './signing-keys'

const HOOK_URL = 'https://example.com/api/hooks/sms-gateway'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

async function signature(
  body: string,
  timestamp: string,
  signingKey: string,
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signed = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${body}${timestamp}`),
    ),
  )
  return [...signed]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function authenticatedEvent(
  rawSigningKeys: string,
  deviceId: string,
  signingKey: string,
): Promise<Response> {
  const body = JSON.stringify({
    deviceId,
    event: 'device:ping',
  })
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const request = new Request(HOOK_URL, {
    method: 'POST',
    headers: {
      'x-signature': await signature(body, timestamp, signingKey),
      'x-timestamp': timestamp,
    },
    body,
  })
  const hookEnv = {
    SMS_GATEWAY_SIGNING_KEYS: rawSigningKeys,
    get DB(): never {
      throw new Error('서명 검증 뒤 알 수 없는 이벤트는 D1을 쓰지 않습니다.')
    },
  } as unknown as Env
  const routeEnv = await smsGatewayWebhookEnv(request, hookEnv)
  return createSmsGatewayWebhookHandler()(
    request,
    routeEnv,
    {},
  )
}

async function authenticatedSmsEvent(
  rawSigningKeys: string,
  deviceId: string,
  signingKey: string,
  messageId: string,
): Promise<Response> {
  const body = JSON.stringify({
    deviceId,
    event: 'sms:received',
    id: `delivery-${messageId}`,
    webhookId: 'webhook-signing-keys',
    payload: {
      messageId,
      message: `수신 ${messageId}`,
      sender: '01022334455',
      recipient: '01099998888',
      simNumber: 1,
      receivedAt: '2026-07-30T14:00:00.000+09:00',
    },
  })
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const request = new Request(HOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': await signature(body, timestamp, signingKey),
      'x-timestamp': timestamp,
    },
    body,
  })
  const hookEnv = new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'SMS_GATEWAY_SIGNING_KEYS') {
        return rawSigningKeys
      }
      return Reflect.get(target, property, receiver)
    },
  }) as Env
  const routeEnv = await smsGatewayWebhookEnv(request, hookEnv)
  return createSmsGatewayWebhookHandler()(
    request,
    routeEnv,
    {},
  )
}

async function seedOfficePhone(deviceId: string): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind('office-signing-keys', '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO office_channels (
        id, office_id, value, label, device_id, is_default, active,
        created_at
      ) VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
    ).bind(
      'phone-signing-keys',
      'office-signing-keys',
      '01099998888',
      '서명키 검증 업무폰',
      deviceId,
      now,
    ),
  ])
}

describe('SMS Gateway signing key configuration', () => {
  it('keeps the legacy device map unchanged', () => {
    const raw = JSON.stringify({
      'device-1': 'legacy-key-1',
      'device-2': 'legacy-key-2',
      default: 'legacy-device-named-default',
    })
    const parsed = parseSigningKeys(raw)

    expect(parsed?.kind).toBe('legacy')
    expect(
      parsed && signingKeyForDevice(parsed, 'device-2'),
    ).toBe('legacy-key-2')
    expect(
      parsed && signingKeyForDevice(parsed, 'default'),
    ).toBe('legacy-device-named-default')
    expect(legacySigningKeysForWebhook(raw, 'device-1')).toBe(raw)
  })

  it('uses an override before the shared default', () => {
    const parsed = parseSigningKeys(
      JSON.stringify({
        default: 'shared-key',
        overrides: { 'device-2': 'override-key' },
      }),
    )

    expect(parsed?.kind).toBe('shared')
    expect(
      parsed && signingKeyForDevice(parsed, 'device-1'),
    ).toBe('shared-key')
    expect(
      parsed && signingKeyForDevice(parsed, 'device-2'),
    ).toBe('override-key')
  })

  it('authenticates every device with the shared default', async () => {
    const raw = JSON.stringify({
      default: 'shared-key',
      overrides: {},
    })

    expect(
      await authenticatedEvent(raw, 'device-1', 'shared-key'),
    ).toHaveProperty('status', 204)
    expect(
      await authenticatedEvent(raw, 'device-2', 'shared-key'),
    ).toHaveProperty('status', 204)
  })

  it('treats a bare default as the shared key', () => {
    // `overrides`를 생략한 형식이 레거시 맵으로 새면 실제 기기의 키가
    // 사라져 수신이 전부 401이 된다. 운영에서 실제로 그렇게 끊겼다.
    const raw = JSON.stringify({ default: 'shared-key' })
    const parsed = parseSigningKeys(raw)

    expect(parsed?.kind).toBe('shared')
    expect(
      parsed && signingKeyForDevice(parsed, 'device-1'),
    ).toBe('shared-key')
    expect(legacySigningKeysForWebhook(raw, 'device-1')).toBe(
      JSON.stringify({ 'device-1': 'shared-key' }),
    )
  })

  it('authenticates a device that no key names', async () => {
    expect(
      await authenticatedEvent(
        JSON.stringify({ default: 'shared-key' }),
        'device-never-listed',
        'shared-key',
      ),
    ).toHaveProperty('status', 204)
  })

  it('authenticates an overridden device only with its override', async () => {
    const raw = JSON.stringify({
      default: 'shared-key',
      overrides: { 'device-2': 'override-key' },
    })

    expect(
      await authenticatedEvent(raw, 'device-2', 'shared-key'),
    ).toHaveProperty('status', 401)
    expect(
      await authenticatedEvent(raw, 'device-2', 'override-key'),
    ).toHaveProperty('status', 204)
  })

  it('stores SMS events with device and shared key formats', async () => {
    const deviceId = 'device-signing-keys'
    await seedOfficePhone(deviceId)

    const deviceKeys = JSON.stringify({
      [deviceId]: 'device-signing-key',
    })
    expect(
      await authenticatedSmsEvent(
        deviceKeys,
        deviceId,
        'different-key',
        'device-key-rejected',
      ),
    ).toHaveProperty('status', 401)
    expect(
      await authenticatedSmsEvent(
        deviceKeys,
        deviceId,
        'device-signing-key',
        'device-key-accepted',
      ),
    ).toHaveProperty('status', 204)

    const sharedKeys = JSON.stringify({
      default: 'shared-signing-key',
    })
    expect(
      await authenticatedSmsEvent(
        sharedKeys,
        deviceId,
        'different-key',
        'shared-key-rejected',
      ),
    ).toHaveProperty('status', 401)
    expect(
      await authenticatedSmsEvent(
        sharedKeys,
        deviceId,
        'shared-signing-key',
        'shared-key-accepted',
      ),
    ).toHaveProperty('status', 204)

    const { results } = await env.DB.prepare(
      `SELECT body
      FROM messages
      WHERE office_id = ?
      ORDER BY body`,
    )
      .bind('office-signing-keys')
      .all<{ body: string }>()
    expect(results.map(({ body }) => body)).toEqual([
      '수신 device-key-accepted',
      '수신 shared-key-accepted',
    ])
  })
})
