import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID,
  TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE,
  testSmsGatewaySignature,
} from '../../tests/sms-gateway-fixtures'
import {
  MMS_DOWNLOAD_MISSING_ERROR_TEXT,
  MMS_DOWNLOAD_WAIT_MS,
  promoteStaleMmsHeaders,
} from '../sms-gateway-mms-diagnostics'
import { smsGatewayIdempotencyKey } from './hooks-sms-gateway'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const HOOK_URL = 'https://example.com/api/hooks/sms-gateway'
const OFFICE_ID = 'office-g14-counterexamples'
const DEVICE_ID = TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID

async function seed(): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(OFFICE_ID, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO office_channels (
         id, office_id, value, label, is_default, active, created_at,
         device_id, signing_key
       ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`,
    ).bind(
      'channel-g14-counterexamples',
      OFFICE_ID,
      '01099998888',
      '업무폰',
      now,
      DEVICE_ID,
      TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE[DEVICE_ID],
    ),
  ])
}

function body(
  event: 'mms:received' | 'mms:downloaded',
  messageId: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    deviceId: DEVICE_ID,
    event,
    id: `${event}-${messageId}`,
    webhookId: 'webhook-g14-counterexamples',
    payload: {
      messageId,
      sender: '01022334455',
      recipient: '01099998888',
      simNumber: 1,
      transactionId:
        event === 'mms:received' ? messageId : null,
      subject: '세금계산서 사진',
      size: 0,
      contentClass: 'personal',
      receivedAt: '2026-07-30T14:00:00+09:00',
      ...(event === 'mms:downloaded'
        ? { body: '첨부 자료입니다.', attachments: [] }
        : {}),
      ...overrides,
    },
  })
}

async function post(rawBody: string): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const signature = await testSmsGatewaySignature(
    rawBody,
    timestamp,
    TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE[DEVICE_ID],
  )
  return SELF.fetch(HOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': signature,
      'x-timestamp': timestamp,
    },
    body: rawBody,
  })
}

async function expectSuccess(rawBody: string): Promise<void> {
  const response = await post(rawBody)
  expect(response.status).toBe(204)
}

describe('G14 review counterexamples', () => {
  it('drops a user subject when it duplicates the body prefix', async () => {
    await seed()
    const messageId = '3101'
    await expectSuccess(
      body('mms:downloaded', messageId, {
        subject: '세금계산서',
        body: '세금계산서 발행 부탁드립니다.',
      }),
    )

    expect(
      await env.DB.prepare(
        'SELECT title FROM messages WHERE mo_key = ?',
      )
        .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
        .first(),
    ).toEqual({ title: null })
  })

  it('promotes only an actually missing download after the wait window', async () => {
    await seed()
    const completedReceivedId = 'transaction-completed'
    const missingReceivedId = 'transaction-missing'

    await expectSuccess(body('mms:received', completedReceivedId))
    await expectSuccess(body('mms:downloaded', '3201'))
    await expectSuccess(body('mms:received', missingReceivedId))

    const pending = await env.DB.prepare(
      `SELECT mo_key, first_at
       FROM sms_gateway_mms_pending
       ORDER BY mo_key`,
    ).all<{ first_at: number; mo_key: string }>()
    expect(pending.results).toEqual([
      {
        first_at: expect.any(Number),
        mo_key: smsGatewayIdempotencyKey(
          DEVICE_ID,
          missingReceivedId,
        ),
      },
    ])
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM mo_failures',
      ).first(),
    ).toEqual({ count: 0 })

    const firstAt = pending.results[0]!.first_at
    await expect(
      promoteStaleMmsHeaders(
        env.DB,
        firstAt + MMS_DOWNLOAD_WAIT_MS - 1,
      ),
    ).resolves.toEqual({ promoted: 0 })
    await expect(
      promoteStaleMmsHeaders(
        env.DB,
        firstAt + MMS_DOWNLOAD_WAIT_MS,
      ),
    ).resolves.toEqual({ promoted: 1 })

    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM sms_gateway_mms_pending',
      ).first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        `SELECT mo_key, error_text
         FROM mo_failures`,
      ).first(),
    ).toEqual({
      error_text: MMS_DOWNLOAD_MISSING_ERROR_TEXT,
      mo_key: smsGatewayIdempotencyKey(
        DEVICE_ID,
        missingReceivedId,
      ),
    })
  })

  it('does not let one replayed download resolve two same-sender headers', async () => {
    await seed()
    const firstReceivedId = 'transaction-first'
    const missingReceivedId = 'transaction-missing'
    const downloaded = body('mms:downloaded', '3301')

    await expectSuccess(body('mms:received', firstReceivedId))
    await expectSuccess(body('mms:received', missingReceivedId))
    await expectSuccess(downloaded)

    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM sms_gateway_mms_pending',
      ).first(),
    ).toEqual({ count: 1 })

    await expectSuccess(downloaded)

    const pendingAfterReplay = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sms_gateway_mms_pending',
    ).first<{ count: number }>()

    await promoteStaleMmsHeaders(
      env.DB,
      Date.now() + MMS_DOWNLOAD_WAIT_MS + 1_000,
    )
    const promotedFailures = await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM mo_failures
         WHERE error_text = ?`,
      )
        .bind(MMS_DOWNLOAD_MISSING_ERROR_TEXT)
        .first<{ count: number }>()
    expect({
      pendingAfterReplay: pendingAfterReplay?.count,
      promotedFailures: promotedFailures?.count,
    }).toEqual({
      pendingAfterReplay: 1,
      promotedFailures: 1,
    })
  })
})
