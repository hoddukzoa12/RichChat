import { describe, expect, it } from 'vitest'
import { smsGatewayWebhookEnv } from '../index'
import { createSmsGatewayWebhookHandler } from '../routes/hooks-sms-gateway'
import {
  legacySigningKeysForWebhook,
  parseSigningKeys,
  signingKeyForDevice,
} from './signing-keys'

const HOOK_URL = 'https://example.com/api/hooks/sms-gateway'

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
  const env = {
    SMS_GATEWAY_SIGNING_KEYS: rawSigningKeys,
    get DB(): never {
      throw new Error('서명 검증 뒤 알 수 없는 이벤트는 D1을 쓰지 않습니다.')
    },
  } as unknown as Env
  const routeEnv = await smsGatewayWebhookEnv(request, env)
  return createSmsGatewayWebhookHandler()(
    request,
    routeEnv,
    {},
  )
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
})
