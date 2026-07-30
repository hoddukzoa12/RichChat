import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID,
  TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE,
  testSmsGatewaySignature,
} from '../../tests/sms-gateway-fixtures'
import {
  createSmsGatewayWebhookHandler,
  MMS_ATTACHMENT_MAX_BYTES,
  smsGatewayIdempotencyKey,
} from './hooks-sms-gateway'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const DEVICE_ID = TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID
const SIGNING_KEY =
  TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE[DEVICE_ID]
const OFFICE_ID = 'office-g12-rereview'
const CHANNEL_ID = 'channel-g12-rereview'
const NOW = Date.UTC(2026, 6, 30, 5)

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function body(
  messageId: string,
  overrides: Record<string, unknown>,
): string {
  return JSON.stringify({
    deviceId: DEVICE_ID,
    event: 'mms:downloaded',
    payload: {
      messageId,
      sender: '01022334455',
      recipient: null,
      subject: null,
      receivedAt: '2026-07-30T14:00:00+09:00',
      body: '본문',
      attachments: [],
      ...overrides,
    },
  })
}

async function request(rawBody: string): Promise<Request> {
  const timestamp = String(Math.floor(NOW / 1_000))
  return new Request('https://example.com/api/hooks/sms-gateway', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': await testSmsGatewaySignature(
        rawBody,
        timestamp,
        SIGNING_KEY,
      ),
      'x-timestamp': timestamp,
    },
    body: rawBody,
  })
}

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(OFFICE_ID, '세무법인 리치', NOW),
    env.DB.prepare(
      `INSERT INTO office_channels (
         id, office_id, value, label, is_default, active, created_at,
         device_id, signing_key
       ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`,
    ).bind(
      CHANNEL_ID,
      OFFICE_ID,
      '01099998888',
      '업무폰',
      NOW,
      DEVICE_ID,
      SIGNING_KEY,
    ),
  ])
}

function withAttachments(bucket: R2Bucket): Env {
  return new Proxy(env as Env, {
    get(target, property, receiver) {
      if (property === 'ATTACHMENTS') return bucket
      return Reflect.get(target, property, receiver) as unknown
    },
  })
}

function bucketWith(
  overrides: Partial<Pick<R2Bucket, 'get' | 'put'>>,
): R2Bucket {
  return new Proxy(env.ATTACHMENTS, {
    get(target, property) {
      const override = overrides[property as 'get' | 'put']
      if (override !== undefined) return override
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function'
        ? value.bind(target)
        : value
    },
  })
}

async function invoke(
  rawBody: string,
  customEnv: Env = env,
): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await createSmsGatewayWebhookHandler({
    clock: () => NOW,
  })(await request(rawBody), customEnv, {}, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

describe('G12 rereview counterexamples', () => {
  it('keeps the committed body and retries when quarantine R2 fails', async () => {
    await seed()
    const messageId = 'quarantine-r2-failure'
    const encodedLength =
      Math.ceil((MMS_ATTACHMENT_MAX_BYTES + 1) / 3) * 4
    const rawBody = body(messageId, {
      body: '격리 실패에도 남는 본문',
      attachments: [
        {
          contentType: 'image/jpeg',
          name: 'large.jpg',
          size: 1,
          data: 'A'.repeat(encodedLength),
        },
      ],
    })
    const failingBucket = bucketWith({
      put: async (key, value, options) => {
        if (String(key).startsWith('quarantine/')) {
          throw new Error('forced quarantine failure')
        }
        return env.ATTACHMENTS.put(key, value, options)
      },
    })

    const failed = await invoke(
      rawBody,
      withAttachments(failingBucket),
    )
    const afterFailure = await env.DB.prepare(
      `SELECT body FROM messages WHERE mo_key = ?`,
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
      .first()
    const retried = await invoke(rawBody)
    const messageCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM messages WHERE mo_key = ?`,
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
      .first<{ count: number }>()
    const failureCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM mo_failures
       WHERE mo_key LIKE 'sms-gateway-mms-oversize/%'`,
    ).first<{ count: number }>()

    expect({
      afterFailure,
      failedStatus: failed.status,
      failureCount: failureCount?.count,
      messageCount: messageCount?.count,
      retriedStatus: retried.status,
    }).toEqual({
      afterFailure: { body: '격리 실패에도 남는 본문' },
      failedStatus: 500,
      failureCount: 1,
      messageCount: 1,
      retriedStatus: 204,
    })
  })

  it('does not let a stale identical replay overwrite a newer generation', async () => {
    await seed()
    const messageId = 'stale-same-generation-check'
    const firstBytes = Uint8Array.of(1)
    const secondBytes = Uint8Array.of(2, 3)
    const first = body(messageId, {
      body: '첫 본문',
      attachments: [
        {
          contentType: 'image/jpeg',
          name: 'first.jpg',
          size: firstBytes.byteLength,
          data: encode(firstBytes),
        },
      ],
    })
    const second = body(messageId, {
      body: '둘째 본문',
      attachments: [
        {
          contentType: 'image/jpeg',
          name: 'second.jpg',
          size: secondBytes.byteLength,
          data: encode(secondBytes),
        },
      ],
    })
    expect((await invoke(first)).status).toBe(204)

    let releaseGet!: () => void
    let enteredGet!: () => void
    const getEntered = new Promise<void>((resolve) => {
      enteredGet = resolve
    })
    const getRelease = new Promise<void>((resolve) => {
      releaseGet = resolve
    })
    const delayedBucket = bucketWith({
      get: async (key, options) => {
        const object = await env.ATTACHMENTS.get(key, options)
        if (object === null) return null
        const captured = await object.arrayBuffer()
        enteredGet()
        await getRelease
        return new Proxy(object, {
          get(target, property) {
            if (property === 'arrayBuffer') {
              return async () => captured.slice(0)
            }
            const value = Reflect.get(target, property, target) as unknown
            return typeof value === 'function'
              ? value.bind(target)
              : value
          },
        })
      },
    })

    const staleReplay = invoke(
      first,
      withAttachments(delayedBucket),
    )
    await getEntered
    expect((await invoke(second)).status).toBe(204)
    releaseGet()
    expect((await staleReplay).status).toBe(204)

    const row = await env.DB.prepare(
      `SELECT
         messages.body,
         message_attachments.original_filename,
         message_attachments.byte_size,
         message_attachments.r2_key
       FROM messages
       JOIN message_attachments
         ON message_attachments.message_id = messages.id
       WHERE messages.mo_key = ?`,
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
      .first<{
        body: string
        byte_size: number
        original_filename: string
        r2_key: string
      }>()
    const object = await env.ATTACHMENTS.get(row!.r2_key)
    const objectBytes = new Uint8Array(await object!.arrayBuffer())

    expect({
      body: row?.body,
      byteSize: row?.byte_size,
      filename: row?.original_filename,
      objectBytes: [...objectBytes],
    }).toEqual({
      body: '둘째 본문',
      byteSize: secondBytes.byteLength,
      filename: 'second.jpg',
      objectBytes: [...secondBytes],
    })
  })

  it('does not complete a null-data image when size is absent', async () => {
    await seed()
    const messageId = 'null-data-without-size'
    const response = await invoke(
      body(messageId, {
        attachments: [
          {
            contentType: 'image/jpeg',
            name: 'photo.jpg',
            data: null,
          },
        ],
      }),
    )
    const row = await env.DB.prepare(
      `SELECT byte_size, download_status, r2_key
       FROM message_attachments
       WHERE message_id = (
         SELECT id FROM messages WHERE mo_key = ?
       )`,
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
      .first()

    expect({ responseStatus: response.status, row }).toEqual({
      responseStatus: 204,
      row: {
        byte_size: 0,
        download_status: '실패',
        r2_key: null,
      },
    })
  })

  it('does not retreat a canonical sort key on an older replay', async () => {
    await seed()
    const messageId = 'canonical-time-retreat'
    const first = body(messageId, {
      body: '정렬키 문의',
      receivedAt: '2026-07-30T14:00:00+09:00',
    })
    const replay = body(messageId, {
      body: '정렬키 문의',
      receivedAt: '2026-07-01T14:00:00+09:00',
    })

    expect((await invoke(first)).status).toBe(204)
    const before = await env.DB.prepare(
      `SELECT messages.occurred_at, conversations.last_message_at
       FROM messages
       JOIN conversations ON conversations.id = messages.conversation_id
       WHERE messages.mo_key = ?`,
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
      .first<{
        last_message_at: number
        occurred_at: number
      }>()
    expect((await invoke(replay)).status).toBe(204)
    const after = await env.DB.prepare(
      `SELECT messages.occurred_at, conversations.last_message_at
       FROM messages
       JOIN conversations ON conversations.id = messages.conversation_id
       WHERE messages.mo_key = ?`,
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
      .first<{
        last_message_at: number
        occurred_at: number
      }>()

    expect({
      after,
      before,
    }).toEqual({
      after: before,
      before,
    })
  })
})
