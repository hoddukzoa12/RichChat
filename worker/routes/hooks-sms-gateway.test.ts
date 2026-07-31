import {
  createExecutionContext,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import {
  TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID,
  TEST_SMS_GATEWAY_SECONDARY_DEVICE_ID,
  TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE,
  testSmsGatewaySignature,
} from '../../tests/sms-gateway-fixtures'
import {
  createSmsGatewayWebhookHandler,
  MMS_ATTACHMENT_MAX_BYTES,
  parseGatewayReportAt,
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

type DeliveryEvent =
  | 'sms:sent'
  | 'sms:delivered'
  | 'sms:failed'

interface OutboundMessageInput {
  clientKey: string
  status?: '대기' | '접수' | '전송중'
}

type MmsEvent = 'mms:received' | 'mms:downloaded'

const PHOTO_BYTES = Uint8Array.of(0, 1, 127, 128, 254, 255)

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function mmsWebhookBody(
  event: MmsEvent,
  messageId: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    deviceId: DEVICE_ID,
    event,
    id: `${event}-${messageId}`,
    webhookId: 'webhook-mms',
    payload: {
      messageId,
      sender: '01022334455',
      recipient: '01099998888',
      simNumber: 1,
      transactionId: `transaction-${messageId}`,
      subject: '세금계산서 사진',
      size: PHOTO_BYTES.byteLength,
      contentClass: 'personal',
      receivedAt: '2026-07-30T14:00:00+09:00',
      ...(event === 'mms:downloaded'
        ? {
            body: '첨부 자료를 확인해 주세요.',
            attachments: [
              {
                partId: 'photo-1',
                contentType: 'image/jpeg',
                name: 'receipt.jpg',
                size: PHOTO_BYTES.byteLength,
                data: base64(PHOTO_BYTES),
              },
            ],
          }
        : {}),
      ...overrides,
    },
  })
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

function deliveryWebhookBody(
  event: DeliveryEvent,
  messageId: string,
  overrides: Record<string, unknown> = {},
): string {
  const timestampKey = {
    'sms:sent': 'sentAt',
    'sms:delivered': 'deliveredAt',
    'sms:failed': 'failedAt',
  } as const satisfies Record<DeliveryEvent, string>

  return JSON.stringify({
    deviceId: DEVICE_ID,
    event,
    id: `delivery-${event}-${messageId}`,
    webhookId: 'webhook-delivery-reports',
    payload: {
      messageId,
      sender: '01099998888',
      recipient: '01022334455',
      simNumber: 1,
      [timestampKey[event]]: '2026-07-30T14:00:00.000+09:00',
      ...overrides,
    },
  })
}

async function signature(
  body: string,
  timestamp: string,
): Promise<string> {
  const { deviceId } = JSON.parse(body) as { deviceId: string }
  const signingKey =
    TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE[
      deviceId as keyof typeof TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE
    ]
  if (signingKey === undefined) {
    throw new Error('테스트 기기의 서명키를 찾지 못했습니다.')
  }

  return testSmsGatewaySignature(body, timestamp, signingKey)
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

async function postWithFailedR2(body: string): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const request = new Request(HOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': await signature(body, timestamp),
      'x-timestamp': timestamp,
    },
    body,
  })
  const ctx = createExecutionContext()
  const response = await createSmsGatewayWebhookHandler({
    putMmsAttachment: async () => {
      throw new Error('forced R2 failure')
    },
  })(request, env, {}, ctx)
  await waitOnExecutionContext(ctx)
  return response
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
             device_id, signing_key
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(
          `channel-sms-gateway-${index + 1}`,
          OFFICE_ID,
          `0109999888${index}`,
          `업무폰 ${index + 1}`,
          index === 0 ? 1 : 0,
          now,
          deviceId,
          TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE[
            deviceId as keyof typeof TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE
          ],
        ),
    ),
  ])
}

async function insertOutboundMessages(
  inputs: readonly OutboundMessageInput[],
): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, office_id, email, name, title, role, status, created_at,
         updated_at
       ) VALUES (
         'user-sms-gateway', ?, 'gateway@rich.test', '박상담', '상담 담당',
         '상담 담당', '활성', ?, ?
       )`,
    ).bind(OFFICE_ID, now, now),
    env.DB.prepare(
      `INSERT INTO customers (
         id, office_id, phone_e164, name, created_at, updated_at
       ) VALUES (
         'customer-sms-gateway', ?, '+821022334455', '업무폰 고객', ?, ?
       )`,
    ).bind(OFFICE_ID, now, now),
    env.DB.prepare(
      `INSERT INTO conversations (
         id, office_id, customer_id, status, created_at, updated_at
       ) VALUES (
         'conversation-sms-gateway', ?, 'customer-sms-gateway',
         '처리중', ?, ?
       )`,
    ).bind(OFFICE_ID, now, now),
    ...inputs.map((input, index) =>
      env.DB
        .prepare(
          `INSERT INTO messages (
             id, office_id, conversation_id, direction, channel, body,
             sender_user_id, occurred_at, created_at, client_key,
             delivery_status
           ) VALUES (
             ?, ?, 'conversation-sms-gateway', 'out', 'SMS', '발송한 문자',
             'user-sms-gateway', ?, ?, ?, ?
           )`,
        )
        .bind(
          `outbound-sms-gateway-${index + 1}`,
          OFFICE_ID,
          now,
          now,
          input.clientKey,
          input.status ?? '접수',
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
  it('parses report times across ISO and epoch formats', () => {
    expect(parseGatewayReportAt('2026-07-30T14:00:00+09:00')).toBe(
      Date.UTC(2026, 6, 30, 5),
    )
    expect(parseGatewayReportAt('2026-07-30T14:00:00')).toBe(
      Date.UTC(2026, 6, 30, 5),
    )
    expect(parseGatewayReportAt(1_785_386_400)).toBe(
      1_785_386_400_000,
    )
    expect(parseGatewayReportAt('1785386400000')).toBe(
      1_785_386_400_000,
    )
    expect(parseGatewayReportAt('not-a-time')).toBeNull()
  })

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
    const timestamp = String(Math.floor(Date.now() / 1_000))

    const rejected = await post(body, {
      timestamp,
      signature: '0'.repeat(64),
    })
    expect(rejected.status).toBe(401)

    await expectSuccess(await post(body))
    const message = await env.DB.prepare(
      'SELECT body FROM messages WHERE mo_key = ?',
    )
      .bind(smsGatewayIdempotencyKey(DEVICE_ID, 'gateway-message-1'))
      .first<{ body: string }>()
    expect(message?.body).toBe('부가세 문의드려요')
  })

  it('records the received header and stores only the downloaded MMS', async () => {
    await insertOfficeChannels()
    const receivedMessageId = 'ZxqUf3r1'
    const downloadedMessageId = '2249'
    const received = mmsWebhookBody(
      'mms:received',
      receivedMessageId,
      { transactionId: receivedMessageId },
    )
    const downloaded = mmsWebhookBody(
      'mms:downloaded',
      downloadedMessageId,
      { transactionId: null },
    )

    await expectSuccess(await post(received))
    await expectSuccess(await post(downloaded))
    await expectSuccess(await post(downloaded))
    await expectSuccess(await post(downloaded))

    const key = smsGatewayIdempotencyKey(
      DEVICE_ID,
      downloadedMessageId,
    )
    const message = await env.DB.prepare(
      `SELECT id, body, title, channel
       FROM messages
       WHERE mo_key = ?`,
    )
      .bind(key)
      .first<{
        body: string
        channel: string
        id: string
        title: string | null
      }>()
    expect(message).toMatchObject({
      body: '첨부 자료를 확인해 주세요.',
      channel: 'MMS',
      title: '세금계산서 사진',
    })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM messages',
      ).first(),
    ).toEqual({ count: 1 })

    const attachments = await env.DB.prepare(
      `SELECT id, byte_size, mime_type, r2_key, download_status
       FROM message_attachments
       WHERE message_id = ?`,
    )
      .bind(message?.id)
      .all<{
        byte_size: number
        download_status: string
        id: string
        mime_type: string
        r2_key: string
      }>()
    expect(attachments.results).toHaveLength(1)
    const attachment = attachments.results[0]!
    expect(attachment).toMatchObject({
      byte_size: PHOTO_BYTES.byteLength,
      download_status: '완료',
      mime_type: 'image/jpeg',
      r2_key: `attachments/${attachment.id}`,
    })
    const object = await env.ATTACHMENTS.get(attachment.r2_key)
    expect(object).not.toBeNull()
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PHOTO_BYTES)

    expect(
      await env.DB.prepare(
        `SELECT inbound_count
         FROM conversations
         WHERE id = (
           SELECT conversation_id FROM messages WHERE mo_key = ?
         )`,
      )
        .bind(key)
        .first(),
    ).toEqual({ inbound_count: 1 })
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM events
         WHERE entity_id = ?`,
      )
        .bind(message?.id)
        .first(),
    ).toEqual({ count: 2 })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM sms_gateway_mms_pending',
      ).first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM mo_failures',
      ).first(),
    ).toEqual({ count: 0 })
  })

  it('stores a downloaded-only MMS and ignores a later received header', async () => {
    await insertOfficeChannels()
    const messageId = '2251'
    const before = Date.now()
    const downloaded = mmsWebhookBody('mms:downloaded', messageId, {
      subject: null,
      receivedAt: 'not-an-observed-time',
      body: '순서가 바뀐 문의',
      attachments: [
        {
          partId: 'body-text',
          contentType: 'text/plain; charset=utf-8',
          name: 'body.txt',
          size: new TextEncoder().encode('순서가 바뀐 문의').byteLength,
          data: base64(new TextEncoder().encode('순서가 바뀐 문의')),
        },
        {
          partId: 'empty-binary',
          contentType: 'application/octet-stream',
          name: 'empty.bin',
          size: 0,
          data: '',
          undocumentedPartField: true,
        },
      ],
      undocumentedPayloadField: 'accepted',
    })

    await expectSuccess(await post(downloaded))
    const after = Date.now()
    const key = smsGatewayIdempotencyKey(DEVICE_ID, messageId)
    const downloadedOnly = await env.DB.prepare(
      `SELECT id, body, title, occurred_at
       FROM messages
       WHERE mo_key = ?`,
    )
      .bind(key)
      .first<{
        body: string
        id: string
        occurred_at: number
        title: string | null
      }>()
    expect(downloadedOnly?.body).toBe('순서가 바뀐 문의')
    expect(downloadedOnly?.title).toBeNull()
    expect(downloadedOnly?.occurred_at).toBeGreaterThanOrEqual(before)
    expect(downloadedOnly?.occurred_at).toBeLessThanOrEqual(after)

    await expectSuccess(
      await post(
        mmsWebhookBody('mms:received', 'ZaqUfdE0', {
          transactionId: 'ZaqUfdE0',
          subject: '나중에 도착한 제목',
          receivedAt: 1_785_386_400,
          productCode: 'unknown-field',
        }),
      ),
    )

    expect(
      await env.DB.prepare(
        `SELECT body, title, channel
         FROM messages
         WHERE mo_key = ?`,
      )
        .bind(key)
        .first(),
    ).toEqual({
      body: '순서가 바뀐 문의',
      channel: 'MMS',
      title: null,
    })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM messages',
      ).first(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM sms_gateway_mms_pending',
      ).first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM mo_failures',
      ).first(),
    ).toEqual({ count: 0 })
    const attachments = await env.DB.prepare(
      `SELECT byte_size, download_status, r2_key
       FROM message_attachments
       WHERE message_id = ?`,
    )
      .bind(downloadedOnly?.id)
      .all<{
        byte_size: number
        download_status: string
        r2_key: string
      }>()
    expect(attachments.results).toEqual([
      {
        byte_size: 0,
        download_status: '완료',
        r2_key: expect.stringMatching(/^attachments\//),
      },
    ])
    const object = await env.ATTACHMENTS.get(
      attachments.results[0]!.r2_key,
    )
    expect(object?.size).toBe(0)
  })

  it('keeps a received-only MMS out of the inbox with one pending header', async () => {
    await insertOfficeChannels()
    const messageId = 'AEqUnzOZ'

    await expectSuccess(
      await post(
        mmsWebhookBody('mms:received', messageId, {
          transactionId: messageId,
          subject: '[제목없음]',
        }),
      ),
    )

    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM messages',
      ).first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM sms_gateway_mms_pending
         WHERE mo_key = ?`,
      )
        .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
        .first(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM mo_failures',
      ).first(),
    ).toEqual({ count: 0 })
  })

  it('filters carrier-generated MMS subjects and keeps a user title', async () => {
    await insertOfficeChannels()
    const cases = [
      {
        messageId: '2301',
        subject: '제목없음',
        body: '첫 번째 실제 본문',
        title: null,
      },
      {
        messageId: '2302',
        subject: '[제목없음]',
        body: '두 번째 실제 본문',
        title: null,
      },
      {
        messageId: '2303',
        subject: '안녕하세요. 한국오에이렌',
        body: '안녕하세요. 한국오에이렌입니다. 문의드립니다.',
        title: null,
      },
      {
        messageId: '2304',
        subject: '세금계산서 사진',
        body: '첨부 자료를 확인해 주세요.',
        title: '세금계산서 사진',
      },
    ] as const

    for (const testCase of cases) {
      await expectSuccess(
        await post(
          mmsWebhookBody('mms:downloaded', testCase.messageId, {
            transactionId: null,
            subject: testCase.subject,
            body: testCase.body,
            attachments: [],
          }),
        ),
      )
    }

    for (const testCase of cases) {
      expect(
        await env.DB.prepare(
          'SELECT title FROM messages WHERE mo_key = ?',
        )
          .bind(
            smsGatewayIdempotencyKey(
              DEVICE_ID,
              testCase.messageId,
            ),
          )
          .first(),
      ).toEqual({ title: testCase.title })
    }
  })

  it('keeps the MMS body and quarantines the raw webhook when an attachment exceeds the limit', async () => {
    await insertOfficeChannels()
    const messageId = 'gateway-mms-oversized'
    const body = mmsWebhookBody('mms:downloaded', messageId, {
      body: '큰 첨부가 있어도 본문은 보존합니다.',
      attachments: [
        {
          partId: 'oversized',
          contentType: 'image/jpeg',
          name: 'oversized.jpg',
          size: MMS_ATTACHMENT_MAX_BYTES + 1,
          data: base64(PHOTO_BYTES),
        },
      ],
    })

    await expectSuccess(await post(body))

    const key = smsGatewayIdempotencyKey(DEVICE_ID, messageId)
    expect(
      await env.DB.prepare(
        `SELECT body FROM messages WHERE mo_key = ?`,
      )
        .bind(key)
        .first(),
    ).toEqual({ body: '큰 첨부가 있어도 본문은 보존합니다.' })
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM message_attachments
         WHERE message_id = (
           SELECT id FROM messages WHERE mo_key = ?
         )`,
      )
        .bind(key)
        .first(),
    ).toEqual({ count: 0 })
    const failure = await env.DB.prepare(
      `SELECT raw_json, error_text
       FROM mo_failures
       WHERE mo_key LIKE 'sms-gateway-mms-oversize/%'`,
    ).first<{ error_text: string; raw_json: string }>()
    const quarantine = JSON.parse(failure!.raw_json) as {
      r2Key: string
      sha256: string
    }
    expect(quarantine.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(quarantine.r2Key).toBe(
      `quarantine/sms-gateway-mms/${quarantine.sha256}.json`,
    )
    const rawWebhook = await env.ATTACHMENTS.get(quarantine.r2Key)
    expect(rawWebhook).not.toBeNull()
    expect(await rawWebhook!.text()).toBe(body)
    expect(failure?.error_text).toContain(
      String(MMS_ATTACHMENT_MAX_BYTES),
    )
  })

  it('keeps the MMS body and marks one attachment failed when R2 rejects it', async () => {
    await insertOfficeChannels()
    const messageId = 'gateway-mms-r2-failure'
    const body = mmsWebhookBody('mms:downloaded', messageId)
    const failure = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})

    await expectSuccess(await postWithFailedR2(body))

    const key = smsGatewayIdempotencyKey(DEVICE_ID, messageId)
    expect(
      await env.DB.prepare(
        `SELECT body FROM messages WHERE mo_key = ?`,
      )
        .bind(key)
        .first(),
    ).toEqual({ body: '첨부 자료를 확인해 주세요.' })
    expect(
      await env.DB.prepare(
        `SELECT download_status, r2_key
         FROM message_attachments
         WHERE message_id = (
           SELECT id FROM messages WHERE mo_key = ?
         )`,
      )
        .bind(key)
        .first(),
    ).toEqual({
      download_status: '실패',
      r2_key: null,
    })

    await expectSuccess(await post(body))
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM message_attachments
         WHERE message_id = (
           SELECT id FROM messages WHERE mo_key = ?
         )`,
      )
        .bind(key)
        .first(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        `SELECT download_status
         FROM message_attachments
         WHERE message_id = (
           SELECT id FROM messages WHERE mo_key = ?
         )`,
      )
        .bind(key)
        .first(),
    ).toEqual({ download_status: '완료' })
    failure.mockRestore()
  })

  it('rejects a forged MMS without storing a message or attachment', async () => {
    await insertOfficeChannels()
    const body = mmsWebhookBody(
      'mms:downloaded',
      'gateway-mms-forged',
    )

    const response = await post(body, {
      signature: '0'.repeat(64),
    })

    expect(response.status).toBe(401)
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM messages',
      ).first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM message_attachments',
      ).first(),
    ).toEqual({ count: 0 })
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
    await insertOfficeChannels()
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {})
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
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('처리하지 않는'),
      expect.objectContaining({ event: 'system:ping' }),
    )
    warning.mockRestore()
  })

  it('applies sent and delivered reports monotonically', async () => {
    await insertOfficeChannels()
    const clientKey = 'gateway-outbound-delivered'
    await insertOutboundMessages([{ clientKey }])

    await expectSuccess(
      await post(deliveryWebhookBody('sms:sent', clientKey)),
    )
    const sent = await env.DB.prepare(
      `SELECT delivery_status, result_code, delivered_at
       FROM messages
       WHERE client_key = ?`,
    )
      .bind(clientKey)
      .first<{
        delivered_at: number | null
        delivery_status: string
        result_code: string | null
      }>()
    expect(sent).toEqual({
      delivered_at: null,
      delivery_status: '전송중',
      result_code: 'Sent',
    })

    const deliveredBody = deliveryWebhookBody(
      'sms:delivered',
      clientKey,
      { deliveredAt: '2026-07-30T14:05:06.789+09:00' },
    )
    await expectSuccess(await post(deliveredBody))
    const delivered = await env.DB.prepare(
      `SELECT delivery_status, result_code, delivered_at
       FROM messages
       WHERE client_key = ?`,
    )
      .bind(clientKey)
      .first<{
        delivered_at: number | null
        delivery_status: string
        result_code: string | null
      }>()
    expect(delivered).toEqual({
      delivered_at: Date.UTC(2026, 6, 30, 5, 5, 6, 789),
      delivery_status: '완료',
      result_code: 'Delivered',
    })

    await expectSuccess(
      await post(deliveryWebhookBody('sms:sent', clientKey)),
    )
    await expectSuccess(await post(deliveredBody))
    expect(
      await env.DB.prepare(
        `SELECT delivery_status, delivered_at
         FROM messages
         WHERE client_key = ?`,
      )
        .bind(clientKey)
        .first(),
    ).toEqual({
      delivered_at: Date.UTC(2026, 6, 30, 5, 5, 6, 789),
      delivery_status: '완료',
    })
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM events
         WHERE entity = 'message'
           AND entity_id = 'outbound-sms-gateway-1'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 2 })
  })

  it('stores a readable failure reason', async () => {
    await insertOfficeChannels()
    const clientKey = 'gateway-outbound-failed'
    await insertOutboundMessages([{ clientKey }])

    await expectSuccess(
      await post(
        deliveryWebhookBody('sms:failed', clientKey, {
          reason: {
            code: 'NO_SERVICE',
            message: '단말에 이동통신 서비스가 없습니다.',
          },
        }),
      ),
    )

    const failed = await env.DB.prepare(
      `SELECT delivery_status, result_code, error_text
       FROM messages
       WHERE client_key = ?`,
    )
      .bind(clientKey)
      .first<{
        delivery_status: string
        error_text: string | null
        result_code: string | null
      }>()
    expect(failed).toEqual({
      delivery_status: '실패',
      error_text:
        'SMS Gateway 발송 실패: 단말에 이동통신 서비스가 없습니다. (NO_SERVICE)',
      result_code: 'Failed',
    })
  })

  it('keeps report authentication on delivery events', async () => {
    await insertOfficeChannels()
    const clientKey = 'gateway-outbound-forged'
    await insertOutboundMessages([{ clientKey }])
    const body = deliveryWebhookBody('sms:delivered', clientKey)

    const response = await post(body, {
      signature: '0'.repeat(64),
    })

    expect(response.status).toBe(401)
    expect(
      await env.DB.prepare(
        `SELECT delivery_status
         FROM messages
         WHERE client_key = ?`,
      )
        .bind(clientKey)
        .first<{ delivery_status: string }>(),
    ).toEqual({ delivery_status: '접수' })
  })

  it('acknowledges and logs an unknown report message', async () => {
    await insertOfficeChannels()
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {})

    await expectSuccess(
      await post(
        deliveryWebhookBody('sms:delivered', 'missing-client-key'),
      ),
    )

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('결합할 메시지가 없는'),
      expect.objectContaining({
        messageIds: ['missing-client-key'],
      }),
    )
    warning.mockRestore()
  })

  it('quarantines malformed known report bodies before acknowledging', async () => {
    await insertOfficeChannels()
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {})
    const body = JSON.stringify({
      deviceId: DEVICE_ID,
      event: 'sms:delivered',
      id: 'malformed-delivery-report',
      webhookId: 'webhook-delivery-reports',
      payload: { deliveredAt: 'unexpected-time-shape' },
    })

    await expectSuccess(await post(body))
    await expectSuccess(await post(body))

    const failure = await env.DB.prepare(
      `SELECT raw_json, error_text, attempts
       FROM mo_failures
       WHERE mo_key LIKE 'sms-gateway-report/%'`,
    ).first<{
      attempts: number
      error_text: string
      raw_json: string
    }>()
    expect(failure).toEqual({
      attempts: 2,
      error_text:
        'GatewayPayloadError: messageId 값이 올바르지 않습니다.',
      raw_json: body,
    })
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('격리했습니다'),
      expect.objectContaining({
        event: 'sms:delivered',
      }),
    )
    warning.mockRestore()
  })

  it('updates status when a report time cannot be parsed', async () => {
    await insertOfficeChannels()
    const clientKey = 'gateway-outbound-invalid-time'
    await insertOutboundMessages([{ clientKey }])

    await expectSuccess(
      await post(
        deliveryWebhookBody('sms:delivered', clientKey, {
          deliveredAt: 'unexpected-time-shape',
        }),
      ),
    )

    expect(
      await env.DB.prepare(
        `SELECT delivery_status, delivered_at
         FROM messages
         WHERE client_key = ?`,
      )
        .bind(clientKey)
        .first(),
    ).toEqual({
      delivered_at: null,
      delivery_status: '완료',
    })
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

  it('rejects an unknown device', async () => {
    const response = await post(webhookBody())

    expect(response.status).toBe(401)
    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages',
    ).first<{ count: number }>()
    expect(messageCount?.count).toBe(0)
  })

  it('rejects a registered device without an issued key', async () => {
    await insertOfficeChannels()
    await env.DB.prepare(
      `UPDATE office_channels
       SET signing_key = NULL
       WHERE device_id = ?`,
    )
      .bind(DEVICE_ID)
      .run()

    const response = await post(webhookBody())

    expect(response.status).toBe(401)
    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages',
    ).first<{ count: number }>()
    expect(messageCount?.count).toBe(0)
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

  it('does not acknowledge downloaded MMS before the body commit succeeds', async () => {
    await insertOfficeChannels()
    await env.DB.prepare(
      `CREATE TRIGGER fail_gateway_mms
       BEFORE INSERT ON messages
       BEGIN
         SELECT RAISE(FAIL, 'forced MMS test failure');
       END`,
    ).run()
    const failure = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    const messageId = 'gateway-mms-commit-failure'

    const response = await post(
      mmsWebhookBody('mms:downloaded', messageId),
    )

    expect(response.status).toBe(500)
    expect(
      await env.DB.prepare(
        'SELECT id FROM messages WHERE mo_key = ?',
      )
        .bind(smsGatewayIdempotencyKey(DEVICE_ID, messageId))
        .first(),
    ).toBeNull()
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM message_attachments',
      ).first(),
    ).toEqual({ count: 0 })
    failure.mockRestore()
  })
})
