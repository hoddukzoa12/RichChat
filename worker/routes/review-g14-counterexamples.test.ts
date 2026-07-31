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

type MmsEvent = 'mms:received' | 'mms:downloaded'

interface EventStep {
  event: MmsEvent
  messageId: string
  sender?: string
}

interface CronMatchCase {
  events: readonly EventStep[]
  expected: {
    inbox: number
    matched: number
    pending: number
    pendingAttempts: number
    promoted: number
  }
  name: string
}

/**
 * 크론 매칭 전이표. 웹훅은 R(received)을 pending에, D(downloaded)를 인박스에
 * append만 한다. 크론은 같은 기기·발신자에서 시각순으로 1:1 매칭하며 D의 영구
 * mo_key 원장이 재생을 제외한다. 결과는 I=인박스, Q=pending, A=pending 시도 합,
 * M=영구 매칭, F=10분 뒤 승격 수다.
 *
 * | 이벤트열             | I | Q | A | M | F |
 * | R                     | 0 | 1 | 1 | 0 | 1 |
 * | R R(replay)           | 0 | 1 | 2 | 0 | 1 |
 * | D                     | 1 | 0 | 0 | 0 | 0 |
 * | D D(replay)           | 1 | 0 | 0 | 0 | 0 |
 * | R D                   | 1 | 0 | 0 | 1 | 0 |
 * | D R                   | 1 | 0 | 0 | 1 | 0 |
 * | R1 R2 D1              | 1 | 1 | 1 | 1 | 1 |
 * | R1 R2 D1 D1(replay)   | 1 | 1 | 1 | 1 | 1 |
 * | R1 R2 D1 D2           | 2 | 0 | 0 | 2 | 0 |
 * | R(sender A) D(sender B)| 1 | 1 | 1 | 0 | 1 |
 * | R D cron R(replay)    | 1 | 0 | 0 | 1 | 0 |
 */
const CRON_MATCH_CASES: readonly CronMatchCase[] = [
  {
    events: [{ event: 'mms:received', messageId: 'table-r-only' }],
    expected: {
      inbox: 0,
      matched: 0,
      pending: 1,
      pendingAttempts: 1,
      promoted: 1,
    },
    name: 'received only',
  },
  {
    events: [
      { event: 'mms:received', messageId: 'table-r-replay' },
      { event: 'mms:received', messageId: 'table-r-replay' },
    ],
    expected: {
      inbox: 0,
      matched: 0,
      pending: 1,
      pendingAttempts: 2,
      promoted: 1,
    },
    name: 'received replay',
  },
  {
    events: [{ event: 'mms:downloaded', messageId: 'table-d-only' }],
    expected: {
      inbox: 1,
      matched: 0,
      pending: 0,
      pendingAttempts: 0,
      promoted: 0,
    },
    name: 'downloaded only',
  },
  {
    events: [
      { event: 'mms:downloaded', messageId: 'table-d-replay' },
      { event: 'mms:downloaded', messageId: 'table-d-replay' },
    ],
    expected: {
      inbox: 1,
      matched: 0,
      pending: 0,
      pendingAttempts: 0,
      promoted: 0,
    },
    name: 'downloaded replay',
  },
  {
    events: [
      { event: 'mms:received', messageId: 'table-forward-r' },
      { event: 'mms:downloaded', messageId: 'table-forward-d' },
    ],
    expected: {
      inbox: 1,
      matched: 1,
      pending: 0,
      pendingAttempts: 0,
      promoted: 0,
    },
    name: 'forward pair',
  },
  {
    events: [
      { event: 'mms:downloaded', messageId: 'table-reverse-d' },
      { event: 'mms:received', messageId: 'table-reverse-r' },
    ],
    expected: {
      inbox: 1,
      matched: 1,
      pending: 0,
      pendingAttempts: 0,
      promoted: 0,
    },
    name: 'reverse pair',
  },
  {
    events: [
      { event: 'mms:received', messageId: 'table-one-r1' },
      { event: 'mms:received', messageId: 'table-one-r2' },
      { event: 'mms:downloaded', messageId: 'table-one-d1' },
    ],
    expected: {
      inbox: 1,
      matched: 1,
      pending: 1,
      pendingAttempts: 1,
      promoted: 1,
    },
    name: 'two headers one download',
  },
  {
    events: [
      { event: 'mms:received', messageId: 'table-replayed-r1' },
      { event: 'mms:received', messageId: 'table-replayed-r2' },
      { event: 'mms:downloaded', messageId: 'table-replayed-d1' },
      { event: 'mms:downloaded', messageId: 'table-replayed-d1' },
    ],
    expected: {
      inbox: 1,
      matched: 1,
      pending: 1,
      pendingAttempts: 1,
      promoted: 1,
    },
    name: 'two headers one replayed download',
  },
  {
    events: [
      { event: 'mms:received', messageId: 'table-two-r1' },
      { event: 'mms:received', messageId: 'table-two-r2' },
      { event: 'mms:downloaded', messageId: 'table-two-d1' },
      { event: 'mms:downloaded', messageId: 'table-two-d2' },
    ],
    expected: {
      inbox: 2,
      matched: 2,
      pending: 0,
      pendingAttempts: 0,
      promoted: 0,
    },
    name: 'two greedy pairs',
  },
  {
    events: [
      {
        event: 'mms:received',
        messageId: 'table-sender-r',
        sender: '01022334455',
      },
      {
        event: 'mms:downloaded',
        messageId: 'table-sender-d',
        sender: '01066778899',
      },
    ],
    expected: {
      inbox: 1,
      matched: 0,
      pending: 1,
      pendingAttempts: 1,
      promoted: 1,
    },
    name: 'different senders',
  },
]

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
  event: MmsEvent,
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
      transactionId: event === 'mms:received' ? messageId : null,
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

async function runEvents(events: readonly EventStep[]): Promise<void> {
  for (const event of events) {
    await expectSuccess(
      body(event.event, event.messageId, {
        ...(event.sender === undefined ? {} : { sender: event.sender }),
      }),
    )
  }
}

async function diagnosticSnapshot(): Promise<{
  inbox: number
  matched: number
  pending: number
  pendingAttempts: number
}> {
  const result = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE channel = 'MMS') AS inbox,
       (SELECT COUNT(*) FROM sms_gateway_mms_pending) AS pending,
       (SELECT COALESCE(SUM(attempts), 0)
        FROM sms_gateway_mms_pending) AS pending_attempts,
       (SELECT COUNT(*) FROM sms_gateway_mms_matches) AS matched`,
  ).first<{
    inbox: number
    matched: number
    pending: number
    pending_attempts: number
  }>()

  return {
    inbox: result?.inbox ?? -1,
    matched: result?.matched ?? -1,
    pending: result?.pending ?? -1,
    pendingAttempts: result?.pending_attempts ?? -1,
  }
}

async function promotedFailureCount(): Promise<number> {
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM mo_failures
     WHERE error_text = ?`,
  )
    .bind(MMS_DOWNLOAD_MISSING_ERROR_TEXT)
    .first<{ count: number }>()
  return result?.count ?? -1
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
    await promoteStaleMmsHeaders(env.DB)

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

    const firstAt = pending.results[0]!.first_at
    await expect(
      promoteStaleMmsHeaders(
        env.DB,
        firstAt + MMS_DOWNLOAD_WAIT_MS - 1,
      ),
    ).resolves.toMatchObject({ promoted: 0 })
    await expect(
      promoteStaleMmsHeaders(
        env.DB,
        firstAt + MMS_DOWNLOAD_WAIT_MS,
      ),
    ).resolves.toMatchObject({ promoted: 1 })
    expect(await promotedFailureCount()).toBe(1)
  })

  it('does not let one replayed download resolve two same-sender headers', async () => {
    await seed()
    const downloaded = body('mms:downloaded', '3301')

    await expectSuccess(body('mms:received', 'transaction-first'))
    await expectSuccess(body('mms:received', 'transaction-missing'))
    await expectSuccess(downloaded)
    await expectSuccess(downloaded)
    await promoteStaleMmsHeaders(env.DB)

    expect(await diagnosticSnapshot()).toMatchObject({
      inbox: 1,
      matched: 1,
      pending: 1,
    })
    await promoteStaleMmsHeaders(
      env.DB,
      Date.now() + MMS_DOWNLOAD_WAIT_MS + 1_000,
    )
    expect(await promotedFailureCount()).toBe(1)
  })

  it('keeps a reverse-order match after the matching header', async () => {
    await seed()
    const downloaded = body('mms:downloaded', '3401')

    await expectSuccess(downloaded)
    await expectSuccess(
      body('mms:received', 'transaction-reverse-completed'),
    )
    await expectSuccess(downloaded)
    await expectSuccess(
      body('mms:received', 'transaction-reverse-missing'),
    )
    await promoteStaleMmsHeaders(env.DB)

    expect(await diagnosticSnapshot()).toMatchObject({
      inbox: 1,
      matched: 1,
      pending: 1,
    })
    await promoteStaleMmsHeaders(
      env.DB,
      Date.now() + MMS_DOWNLOAD_WAIT_MS + 1_000,
    )
    expect(await promotedFailureCount()).toBe(1)
  })

  it('does not reuse an old download replay for a new header', async () => {
    await seed()
    const oldDownloaded = body('mms:downloaded', '3501')

    await expectSuccess(oldDownloaded)
    await expectSuccess(
      body('mms:received', 'transaction-expired-completed'),
    )
    await promoteStaleMmsHeaders(env.DB)

    await expectSuccess(
      body('mms:received', 'transaction-after-expiration'),
    )
    await expectSuccess(oldDownloaded)
    await promoteStaleMmsHeaders(env.DB)

    expect(await diagnosticSnapshot()).toMatchObject({
      inbox: 1,
      matched: 1,
      pending: 1,
    })
    await promoteStaleMmsHeaders(
      env.DB,
      Date.now() + MMS_DOWNLOAD_WAIT_MS + 1_000,
    )
    expect(await promotedFailureCount()).toBe(1)
  })

  it('leaves both webhook paths append-only until cron runs', async () => {
    await seed()
    await expectSuccess(body('mms:received', 'append-only-r'))
    await expectSuccess(body('mms:downloaded', 'append-only-d'))

    expect(await diagnosticSnapshot()).toEqual({
      inbox: 1,
      matched: 0,
      pending: 1,
      pendingAttempts: 1,
    })
    await promoteStaleMmsHeaders(env.DB)
    expect(await diagnosticSnapshot()).toMatchObject({
      matched: 1,
      pending: 0,
    })
  })

  it('does not append a received replay after its permanent match', async () => {
    await seed()
    const received = body('mms:received', 'matched-received-replay')

    await expectSuccess(received)
    await expectSuccess(
      body('mms:downloaded', 'matched-downloaded'),
    )
    await promoteStaleMmsHeaders(env.DB)
    await expectSuccess(received)

    expect(await diagnosticSnapshot()).toEqual({
      inbox: 1,
      matched: 1,
      pending: 0,
      pendingAttempts: 0,
    })
    await promoteStaleMmsHeaders(
      env.DB,
      Date.now() + MMS_DOWNLOAD_WAIT_MS + 1_000,
    )
    expect(await promotedFailureCount()).toBe(0)
  })

  it('matches inside the inclusive wait window only', async () => {
    await seed()
    const withinReceivedId = 'window-within-r'
    const withinDownloadedId = 'window-within-d'
    const outsideReceivedId = 'window-outside-r'
    const outsideDownloadedId = 'window-outside-d'
    const outsideSender = '01066778899'

    await expectSuccess(body('mms:received', withinReceivedId))
    await expectSuccess(body('mms:downloaded', withinDownloadedId))
    await expectSuccess(
      body('mms:received', outsideReceivedId, {
        sender: outsideSender,
      }),
    )
    await expectSuccess(
      body('mms:downloaded', outsideDownloadedId, {
        sender: outsideSender,
      }),
    )

    const pending = await env.DB.prepare(
      `SELECT mo_key, first_at
       FROM sms_gateway_mms_pending`,
    ).all<{ first_at: number; mo_key: string }>()
    const firstAtByKey = new Map(
      pending.results.map(({ first_at, mo_key }) => [mo_key, first_at]),
    )
    const withinFirstAt = firstAtByKey.get(
      smsGatewayIdempotencyKey(DEVICE_ID, withinReceivedId),
    )
    const outsideFirstAt = firstAtByKey.get(
      smsGatewayIdempotencyKey(DEVICE_ID, outsideReceivedId),
    )
    if (withinFirstAt === undefined || outsideFirstAt === undefined) {
      throw new Error('경계 테스트의 pending 시각을 찾지 못했습니다.')
    }

    await env.DB.batch([
      env.DB.prepare(
        'UPDATE messages SET created_at = ? WHERE mo_key = ?',
      ).bind(
        withinFirstAt + MMS_DOWNLOAD_WAIT_MS,
        smsGatewayIdempotencyKey(DEVICE_ID, withinDownloadedId),
      ),
      env.DB.prepare(
        'UPDATE messages SET created_at = ? WHERE mo_key = ?',
      ).bind(
        outsideFirstAt + MMS_DOWNLOAD_WAIT_MS + 1,
        smsGatewayIdempotencyKey(DEVICE_ID, outsideDownloadedId),
      ),
    ])

    await promoteStaleMmsHeaders(env.DB)
    expect(await diagnosticSnapshot()).toMatchObject({
      matched: 1,
      pending: 1,
    })
    await promoteStaleMmsHeaders(
      env.DB,
      outsideFirstAt + MMS_DOWNLOAD_WAIT_MS,
    )
    expect(await promotedFailureCount()).toBe(1)
  })

  it.each(CRON_MATCH_CASES)('matches $name', async (scenario) => {
    await seed()
    await runEvents(scenario.events)
    await promoteStaleMmsHeaders(env.DB)

    const beforePromotion = await diagnosticSnapshot()
    await promoteStaleMmsHeaders(
      env.DB,
      Date.now() + MMS_DOWNLOAD_WAIT_MS + 1_000,
    )
    expect({
      ...beforePromotion,
      promoted: await promotedFailureCount(),
    }).toEqual(scenario.expected)
  })
})
