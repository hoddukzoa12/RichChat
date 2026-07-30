import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { OfficePhoneSigningKeyResponse } from '../../shared/wire/office'
import { testSmsGatewaySignature } from '../../tests/sms-gateway-fixtures'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import { smsGatewayIdempotencyKey } from './hooks-sms-gateway'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
let sequence = 0

interface Fixture {
  token: string
  phoneId: string
  deviceId: string
  unissuedDeviceId: string
}

async function seedFixture(): Promise<Fixture> {
  sequence += 1
  const suffix = `signing-key-e2e-${sequence}`
  const officeId = `office-${suffix}`
  const userId = `admin-${suffix}`
  const phoneId = `phone-${suffix}`
  const deviceId = `device-${suffix}`
  const unissuedDeviceId = `device-unissued-${suffix}`
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at,
        updated_at
      ) VALUES (?, ?, ?, '관리자', '대표', '관리자', '활성', ?, ?)`,
    ).bind(userId, officeId, `${userId}@rich.test`, now, now),
    ...[
      { id: phoneId, deviceId, value: '01056129001' },
      {
        id: `phone-unissued-${suffix}`,
        deviceId: unissuedDeviceId,
        value: '01056129002',
      },
    ].map((phone) =>
      env.DB.prepare(
        `INSERT INTO office_channels (
          id, office_id, value, label, device_id, is_default, active,
          created_at
        ) VALUES (?, ?, ?, '업무폰', ?, 0, 1, ?)`,
      ).bind(
        phone.id,
        officeId,
        phone.value,
        phone.deviceId,
        now,
      ),
    ),
  ])
  const session = await createSession(
    env.DB,
    { userId, officeId },
    now,
  )
  return {
    token: session.token,
    phoneId,
    deviceId,
    unissuedDeviceId,
  }
}

async function issueKey(
  fixture: Fixture,
): Promise<OfficePhoneSigningKeyResponse> {
  const response = await SELF.fetch(
    `${ORIGIN}/api/office/phones/${fixture.phoneId}/signing-key`,
    {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE_NAME}=${fixture.token}`,
      },
    },
  )
  expect(response.status).toBe(200)
  return response.json<OfficePhoneSigningKeyResponse>()
}

function webhookBody(
  deviceId: string,
  messageId: string,
): string {
  return JSON.stringify({
    deviceId,
    event: 'sms:received',
    id: `delivery-${messageId}`,
    webhookId: 'webhook-signing-key-e2e',
    payload: {
      messageId,
      message: `문의 ${messageId}`,
      sender: '01022334455',
      recipient: '01056129001',
      simNumber: 1,
      receivedAt: new Date().toISOString(),
    },
  })
}

async function postWebhook(
  body: string,
  signingKey: string,
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1_000))
  return SELF.fetch(`${ORIGIN}/api/hooks/sms-gateway`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': await testSmsGatewaySignature(
        body,
        timestamp,
        signingKey,
      ),
      'x-timestamp': timestamp,
    },
    body,
  })
}

describe('Office phone signing-key end-to-end flow', () => {
  it('uses the issued D1 key and invalidates the previous key immediately', async () => {
    const fixture = await seedFixture()
    const unissued = await postWebhook(
      webhookBody(fixture.unissuedDeviceId, 'unissued'),
      'unissued-device-key',
    )
    expect(unissued.status).toBe(401)

    const firstIssue = await issueKey(fixture)
    const validBody = webhookBody(fixture.deviceId, 'first-valid')
    const invalid = await postWebhook(validBody, 'different-key')
    const valid = await postWebhook(
      validBody,
      firstIssue.signingKey,
    )
    expect(invalid.status).toBe(401)
    expect(valid.status).toBe(204)

    const replayBody = webhookBody(
      fixture.deviceId,
      'before-reissue',
    )
    const beforeReissue = await postWebhook(
      replayBody,
      firstIssue.signingKey,
    )
    expect(beforeReissue.status).toBe(204)

    const secondIssue = await issueKey(fixture)
    expect(secondIssue.signingKey).not.toBe(firstIssue.signingKey)
    const oldKeyAfterReissue = await postWebhook(
      replayBody,
      firstIssue.signingKey,
    )
    expect(oldKeyAfterReissue.status).toBe(401)

    const afterBody = webhookBody(
      fixture.deviceId,
      'after-reissue',
    )
    const newKeyAfterReissue = await postWebhook(
      afterBody,
      secondIssue.signingKey,
    )
    expect(newKeyAfterReissue.status).toBe(204)

    const { results } = await env.DB.prepare(
      `SELECT mo_key
       FROM messages
       WHERE mo_key IN (?, ?, ?)
       ORDER BY mo_key`,
    )
      .bind(
        smsGatewayIdempotencyKey(fixture.deviceId, 'first-valid'),
        smsGatewayIdempotencyKey(
          fixture.deviceId,
          'before-reissue',
        ),
        smsGatewayIdempotencyKey(
          fixture.deviceId,
          'after-reissue',
        ),
      )
      .all<{ mo_key: string }>()
    expect(results).toHaveLength(3)
  })
})
