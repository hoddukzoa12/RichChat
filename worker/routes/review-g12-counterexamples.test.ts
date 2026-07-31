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
const OFFICE_ID = 'office-g12-review'
const CHANNEL_ID = 'channel-g12-review'
const NOW = Date.UTC(2026, 6, 30, 5)

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function body(
  event: 'mms:received' | 'mms:downloaded',
  messageId: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    deviceId: DEVICE_ID,
    event,
    payload: {
      messageId,
      sender: '01022334455',
      recipient: null,
      subject: null,
      receivedAt: '2026-07-30T14:00:00+09:00',
      ...(event === 'mms:downloaded'
        ? { body: '본문 A', attachments: [] }
        : {}),
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

async function invoke(
  rawBody: string,
  putMmsAttachment?: (
    bucket: R2Bucket,
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ) => Promise<void>,
): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await createSmsGatewayWebhookHandler({
    clock: () => NOW,
    putMmsAttachment,
  })(await request(rawBody), env, {}, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

describe('G12 review counterexamples', () => {
  it('quarantines an actually oversized Base64 part before decoding', async () => {
    await seed()
    const messageId = 'actual-oversized-base64'
    const encodedLength =
      Math.ceil((MMS_ATTACHMENT_MAX_BYTES + 1) / 3) * 4
    const response = await invoke(
      body('mms:downloaded', messageId, {
        body: '큰 첨부 본문',
        attachments: [
          {
            contentType: 'image/jpeg',
            name: 'large.jpg',
            size: 1,
            data: 'A'.repeat(encodedLength),
          },
        ],
      }),
    )

    const persisted = await env.DB.prepare(
        `SELECT
           messages.body,
           (
             SELECT COUNT(*)
             FROM message_attachments
             WHERE message_id = messages.id
           ) AS attachment_count
       FROM messages
         WHERE mo_key = ?`,
      )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
      .first()
    const failureCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM mo_failures
       WHERE mo_key LIKE 'sms-gateway-mms-oversize/%'`,
    ).first<{ count: number }>()
    expect({
      failureCount: failureCount?.count,
      persisted,
      status: response.status,
    }).toEqual({
      failureCount: 1,
      persisted: {
        attachment_count: 0,
        body: '큰 첨부 본문',
      },
      status: 204,
    })
  })

  it('keeps a non-empty attachment with null data out of completed state', async () => {
    await seed()
    const messageId = 'null-data-nonempty'
    expect(
      (
        await invoke(
          body('mms:downloaded', messageId, {
            attachments: [
              {
                partId: 'photo',
                contentType: 'image/jpeg',
                name: 'photo.jpg',
                size: 6,
                data: null,
              },
            ],
          }),
        )
      ).status,
    ).toBe(204)

    const row = await env.DB.prepare(
      `SELECT byte_size, download_status, r2_key
       FROM message_attachments
       WHERE message_id = (
         SELECT id FROM messages WHERE mo_key = ?
       )`,
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
      .first<{
        byte_size: number
        download_status: string
        r2_key: string | null
      }>()

    expect(row).toEqual({
      byte_size: 6,
      download_status: '실패',
      r2_key: null,
    })
  })

  it('produces the same occurrence time in either webhook order', async () => {
    await seed()
    const firstDownloadedId = '2249'
    const secondDownloadedId = '2251'
    const receivedFirst = body('mms:received', 'ZxqUf3r1', {
      receivedAt: 'invalid',
      transactionId: 'ZxqUf3r1',
    })
    const downloadedFirst = body('mms:downloaded', secondDownloadedId, {
      receivedAt: '2026-07-01T14:00:00+09:00',
    })

    await invoke(receivedFirst)
    await invoke(
      body('mms:downloaded', firstDownloadedId, {
        receivedAt: '2026-07-01T14:00:00+09:00',
      }),
    )
    await invoke(downloadedFirst)
    await invoke(
      body('mms:received', 'ZaqUfdE0', {
        receivedAt: 'invalid',
        transactionId: 'ZaqUfdE0',
      }),
    )

    const rows = await env.DB.prepare(
      `SELECT mo_key, occurred_at
       FROM messages
       WHERE mo_key IN (?, ?)
       ORDER BY mo_key`,
    )
      .bind(
        smsGatewayIdempotencyKey(DEVICE_ID, firstDownloadedId),
        smsGatewayIdempotencyKey(DEVICE_ID, secondDownloadedId),
      )
      .all<{ mo_key: string; occurred_at: number }>()

    const canonicalTime = Date.UTC(2026, 6, 1, 5)
    expect(rows.results).toEqual([
      {
        mo_key: smsGatewayIdempotencyKey(
          DEVICE_ID,
          firstDownloadedId,
        ),
        occurred_at: canonicalTime,
      },
      {
        mo_key: smsGatewayIdempotencyKey(
          DEVICE_ID,
          secondDownloadedId,
        ),
        occurred_at: canonicalTime,
      },
    ])
  })

  it('keeps D1 metadata and R2 bytes from the same concurrent completion', async () => {
    await seed()
    const messageId = 'concurrent-different-content'
    const firstBytes = Uint8Array.of(1)
    const secondBytes = Uint8Array.of(2, 3)
    let releaseFirst!: () => void
    let enteredFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let putCount = 0
    const controlledPut = async (
      bucket: R2Bucket,
      key: string,
      bytes: Uint8Array,
      contentType: string,
    ): Promise<void> => {
      putCount += 1
      if (putCount === 1) {
        enteredFirst()
        await firstRelease
      }
      await bucket.put(key, bytes, {
        httpMetadata: { contentType },
      })
    }
    const first = body('mms:downloaded', messageId, {
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
    const second = body('mms:downloaded', messageId, {
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

    const firstResponse = invoke(first, controlledPut)
    await firstEntered
    const secondResponse = await invoke(second, controlledPut)
    releaseFirst()
    expect((await firstResponse).status).toBe(204)
    expect(secondResponse.status).toBe(204)

    const row = await env.DB.prepare(
      `SELECT original_filename, byte_size, r2_key
       FROM message_attachments
       WHERE message_id = (
         SELECT id FROM messages WHERE mo_key = ?
       )`,
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
      .first<{
        original_filename: string
        byte_size: number
        r2_key: string
      }>()
    const object = await env.ATTACHMENTS.get(row!.r2_key)
    const storedBytes = new Uint8Array(await object!.arrayBuffer())

    expect({
      filename: row!.original_filename,
      metadataBytes: row!.byte_size,
      objectBytes: [...storedBytes],
    }).toEqual({
      filename: 'second.jpg',
      metadataBytes: secondBytes.byteLength,
      objectBytes: [...secondBytes],
    })
  })

  it('keeps body and attachment from one sequential downloaded event', async () => {
    await seed()
    const messageId = 'sequential-different-content'
    const firstBytes = Uint8Array.of(10)
    const secondBytes = Uint8Array.of(20, 30)

    await invoke(
      body('mms:downloaded', messageId, {
        body: '첫 본문',
        attachments: [
          {
            contentType: 'image/jpeg',
            name: 'first.jpg',
            size: firstBytes.byteLength,
            data: encode(firstBytes),
          },
        ],
      }),
    )
    await invoke(
      body('mms:downloaded', messageId, {
        body: '둘째 본문',
        attachments: [
          {
            contentType: 'image/jpeg',
            name: 'second.jpg',
            size: secondBytes.byteLength,
            data: encode(secondBytes),
          },
        ],
      }),
    )

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
        original_filename: string
        byte_size: number
        r2_key: string
      }>()
    const object = await env.ATTACHMENTS.get(row!.r2_key)
    const storedBytes = new Uint8Array(await object!.arrayBuffer())

    expect({
      body: row!.body,
      filename: row!.original_filename,
      metadataBytes: row!.byte_size,
      objectBytes: [...storedBytes],
    }).toEqual({
      body: '둘째 본문',
      filename: 'second.jpg',
      metadataBytes: secondBytes.byteLength,
      objectBytes: [...secondBytes],
    })
  })
})
