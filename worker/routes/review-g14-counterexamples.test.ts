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
const TRANSITION_RECEIVED_ID = 'transition-received'
const TRANSITION_DOWNLOADED_ID = 'transition-downloaded'
const EXISTING_DOWNLOADED_ID = 'transition-existing-downloaded'
const EXISTING_PENDING_ID = 'transition-existing-pending'
const EXISTING_MATCHED_ID = 'transition-existing-matched'

const TRANSITION_DIMENSIONS = {
  event: [
    'received-first',
    'received-replay',
    'downloaded-first',
    'downloaded-replay',
  ],
  marker: ['none', 'waiting', 'consumed'],
  pending: ['absent', 'present'],
} as const

type MarkerState = (typeof TRANSITION_DIMENSIONS.marker)[number]
type PendingState = (typeof TRANSITION_DIMENSIONS.pending)[number]
type TransitionEvent = (typeof TRANSITION_DIMENSIONS.event)[number]

interface TransitionCase {
  event: TransitionEvent
  expected: {
    inbox: number
    marker: string
    pending: number
    promoted: number
  }
  marker: MarkerState
  name: string
  pending: PendingState
}

/**
 * MMS 진단 전이표. M은 시작 표식(∅/0/1), E는 들어온 이벤트, P는 시작
 * pending 수다. 결과는 I=인박스 수, Q=pending 수, T=표식 consumed 상태,
 * F=10분 뒤 승격 수다. 쉼표로 묶인 T는 같은 발신자의 표식이 여러 개란 뜻이다.
 * first+P=1의 기존 pending은 다른 MMS이고, received replay+P=1은 같은
 * received 키다. consumed+received replay는 표식의 received_mo_key도 같다.
 *
 * | M | E                 | P | I | Q | T   | F |
 * | ∅ | received first    | 0 | 0 | 1 | ∅   | 1 |
 * | ∅ | received first    | 1 | 0 | 2 | ∅   | 2 |
 * | ∅ | received replay   | 0 | 0 | 1 | ∅   | 1 |
 * | ∅ | received replay   | 1 | 0 | 1 | ∅   | 1 |
 * | ∅ | downloaded first  | 0 | 1 | 0 | 0   | 0 |
 * | ∅ | downloaded first  | 1 | 1 | 0 | 1   | 0 |
 * | ∅ | downloaded replay | 0 | 1 | 0 | 0   | 0 |
 * | ∅ | downloaded replay | 1 | 1 | 0 | 1   | 0 |
 * | 0 | received first    | 0 | 1 | 0 | 1   | 0 |
 * | 0 | received first    | 1 | 1 | 1 | 1   | 1 |
 * | 0 | received replay   | 0 | 1 | 0 | 1   | 0 |
 * | 0 | received replay   | 1 | 1 | 0 | 1   | 0 |
 * | 0 | downloaded first  | 0 | 2 | 0 | 0,0 | 0 |
 * | 0 | downloaded first  | 1 | 2 | 0 | 0,1 | 0 |
 * | 0 | downloaded replay | 0 | 1 | 0 | 0   | 0 |
 * | 0 | downloaded replay | 1 | 1 | 1 | 0   | 1 |
 * | 1 | received first    | 0 | 1 | 1 | 1   | 1 |
 * | 1 | received first    | 1 | 1 | 2 | 1   | 2 |
 * | 1 | received replay   | 0 | 1 | 0 | 1   | 0 |
 * | 1 | received replay   | 1 | 1 | 0 | 1   | 0 |
 * | 1 | downloaded first  | 0 | 2 | 0 | 0,1 | 0 |
 * | 1 | downloaded first  | 1 | 2 | 0 | 1,1 | 0 |
 * | 1 | downloaded replay | 0 | 1 | 0 | 1   | 0 |
 * | 1 | downloaded replay | 1 | 1 | 1 | 1   | 1 |
 */
const TRANSITION_CASES: readonly TransitionCase[] = [
  {
    event: 'received-first',
    expected: { inbox: 0, marker: 'none', pending: 1, promoted: 1 },
    marker: 'none',
    name: 'none received-first absent',
    pending: 'absent',
  },
  {
    event: 'received-first',
    expected: { inbox: 0, marker: 'none', pending: 2, promoted: 2 },
    marker: 'none',
    name: 'none received-first present',
    pending: 'present',
  },
  {
    event: 'received-replay',
    expected: { inbox: 0, marker: 'none', pending: 1, promoted: 1 },
    marker: 'none',
    name: 'none received-replay absent',
    pending: 'absent',
  },
  {
    event: 'received-replay',
    expected: { inbox: 0, marker: 'none', pending: 1, promoted: 1 },
    marker: 'none',
    name: 'none received-replay present',
    pending: 'present',
  },
  {
    event: 'downloaded-first',
    expected: { inbox: 1, marker: '0', pending: 0, promoted: 0 },
    marker: 'none',
    name: 'none downloaded-first absent',
    pending: 'absent',
  },
  {
    event: 'downloaded-first',
    expected: { inbox: 1, marker: '1', pending: 0, promoted: 0 },
    marker: 'none',
    name: 'none downloaded-first present',
    pending: 'present',
  },
  {
    event: 'downloaded-replay',
    expected: { inbox: 1, marker: '0', pending: 0, promoted: 0 },
    marker: 'none',
    name: 'none downloaded-replay absent',
    pending: 'absent',
  },
  {
    event: 'downloaded-replay',
    expected: { inbox: 1, marker: '1', pending: 0, promoted: 0 },
    marker: 'none',
    name: 'none downloaded-replay present',
    pending: 'present',
  },
  {
    event: 'received-first',
    expected: { inbox: 1, marker: '1', pending: 0, promoted: 0 },
    marker: 'waiting',
    name: 'waiting received-first absent',
    pending: 'absent',
  },
  {
    event: 'received-first',
    expected: { inbox: 1, marker: '1', pending: 1, promoted: 1 },
    marker: 'waiting',
    name: 'waiting received-first present',
    pending: 'present',
  },
  {
    event: 'received-replay',
    expected: { inbox: 1, marker: '1', pending: 0, promoted: 0 },
    marker: 'waiting',
    name: 'waiting received-replay absent',
    pending: 'absent',
  },
  {
    event: 'received-replay',
    expected: { inbox: 1, marker: '1', pending: 0, promoted: 0 },
    marker: 'waiting',
    name: 'waiting received-replay present',
    pending: 'present',
  },
  {
    event: 'downloaded-first',
    expected: { inbox: 2, marker: '0,0', pending: 0, promoted: 0 },
    marker: 'waiting',
    name: 'waiting downloaded-first absent',
    pending: 'absent',
  },
  {
    event: 'downloaded-first',
    expected: { inbox: 2, marker: '0,1', pending: 0, promoted: 0 },
    marker: 'waiting',
    name: 'waiting downloaded-first present',
    pending: 'present',
  },
  {
    event: 'downloaded-replay',
    expected: { inbox: 1, marker: '0', pending: 0, promoted: 0 },
    marker: 'waiting',
    name: 'waiting downloaded-replay absent',
    pending: 'absent',
  },
  {
    event: 'downloaded-replay',
    expected: { inbox: 1, marker: '0', pending: 1, promoted: 1 },
    marker: 'waiting',
    name: 'waiting downloaded-replay present',
    pending: 'present',
  },
  {
    event: 'received-first',
    expected: { inbox: 1, marker: '1', pending: 1, promoted: 1 },
    marker: 'consumed',
    name: 'consumed received-first absent',
    pending: 'absent',
  },
  {
    event: 'received-first',
    expected: { inbox: 1, marker: '1', pending: 2, promoted: 2 },
    marker: 'consumed',
    name: 'consumed received-first present',
    pending: 'present',
  },
  {
    event: 'received-replay',
    expected: { inbox: 1, marker: '1', pending: 0, promoted: 0 },
    marker: 'consumed',
    name: 'consumed received-replay absent',
    pending: 'absent',
  },
  {
    event: 'received-replay',
    expected: { inbox: 1, marker: '1', pending: 0, promoted: 0 },
    marker: 'consumed',
    name: 'consumed received-replay present',
    pending: 'present',
  },
  {
    event: 'downloaded-first',
    expected: { inbox: 2, marker: '0,1', pending: 0, promoted: 0 },
    marker: 'consumed',
    name: 'consumed downloaded-first absent',
    pending: 'absent',
  },
  {
    event: 'downloaded-first',
    expected: { inbox: 2, marker: '1,1', pending: 0, promoted: 0 },
    marker: 'consumed',
    name: 'consumed downloaded-first present',
    pending: 'present',
  },
  {
    event: 'downloaded-replay',
    expected: { inbox: 1, marker: '1', pending: 0, promoted: 0 },
    marker: 'consumed',
    name: 'consumed downloaded-replay absent',
    pending: 'absent',
  },
  {
    event: 'downloaded-replay',
    expected: { inbox: 1, marker: '1', pending: 1, promoted: 1 },
    marker: 'consumed',
    name: 'consumed downloaded-replay present',
    pending: 'present',
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

function transitionMoKey(messageId: string): string {
  return smsGatewayIdempotencyKey(DEVICE_ID, messageId)
}

async function prepareTransitionState(
  scenario: TransitionCase,
): Promise<void> {
  const downloadedReplay = scenario.event === 'downloaded-replay'
  if (scenario.marker !== 'none' || downloadedReplay) {
    const markerMessageId = downloadedReplay
      ? TRANSITION_DOWNLOADED_ID
      : EXISTING_DOWNLOADED_ID
    await expectSuccess(body('mms:downloaded', markerMessageId))
    const markerMoKey = transitionMoKey(markerMessageId)

    if (scenario.marker === 'none') {
      await env.DB.prepare(
        'DELETE FROM sms_gateway_mms_downloaded WHERE mo_key = ?',
      )
        .bind(markerMoKey)
        .run()
    } else if (scenario.marker === 'consumed') {
      const receivedMoKey =
        scenario.event === 'received-replay'
          ? transitionMoKey(TRANSITION_RECEIVED_ID)
          : transitionMoKey(EXISTING_MATCHED_ID)
      await env.DB.prepare(
        `UPDATE sms_gateway_mms_downloaded
         SET consumed = 1,
             received_mo_key = ?
         WHERE mo_key = ?`,
      )
        .bind(receivedMoKey, markerMoKey)
        .run()
    }
  }

  if (scenario.pending === 'present') {
    const pendingMessageId =
      scenario.event === 'received-replay'
        ? TRANSITION_RECEIVED_ID
        : EXISTING_PENDING_ID
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO sms_gateway_mms_pending (
         mo_key, device_id, sender_e164, raw_json,
         attempts, first_at, last_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        transitionMoKey(pendingMessageId),
        DEVICE_ID,
        '+821022334455',
        '{"event":"mms:received"}',
        now,
        now,
      )
      .run()
  }
}

async function runTransitionEvent(event: TransitionEvent): Promise<void> {
  const received = event.startsWith('received')
  await expectSuccess(
    body(
      received ? 'mms:received' : 'mms:downloaded',
      received ? TRANSITION_RECEIVED_ID : TRANSITION_DOWNLOADED_ID,
    ),
  )
}

async function transitionSnapshot(): Promise<{
  inbox: number
  marker: string
  pending: number
}> {
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE channel = 'MMS') AS inbox,
       (SELECT COUNT(*) FROM sms_gateway_mms_pending) AS pending`,
  ).first<{ inbox: number; pending: number }>()
  const markers = await env.DB.prepare(
    `SELECT consumed
     FROM sms_gateway_mms_downloaded
     ORDER BY consumed, mo_key`,
  ).all<{ consumed: number }>()

  return {
    inbox: counts?.inbox ?? -1,
    marker:
      markers.results.length === 0
        ? 'none'
        : markers.results.map(({ consumed }) => consumed).join(','),
    pending: counts?.pending ?? -1,
  }
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

  it('keeps a reverse-order tombstone after the matching header', async () => {
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

    const pendingBeforePromotion = await env.DB.prepare(
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
      pendingBeforePromotion: pendingBeforePromotion?.count,
      promotedFailures: promotedFailures?.count,
    }).toEqual({
      pendingBeforePromotion: 1,
      promotedFailures: 1,
    })
  })

  it('covers every closed transition exactly once', () => {
    const expected = TRANSITION_DIMENSIONS.marker.flatMap((marker) =>
      TRANSITION_DIMENSIONS.event.flatMap((event) =>
        TRANSITION_DIMENSIONS.pending.map(
          (pending) => `${marker}:${event}:${pending}`,
        ),
      ),
    )
    const actual = TRANSITION_CASES.map(
      ({ event, marker, pending }) => `${marker}:${event}:${pending}`,
    )

    expect(actual.sort()).toEqual(expected.sort())
  })

  it.each(TRANSITION_CASES)('covers $name', async (scenario) => {
    await seed()
    await prepareTransitionState(scenario)
    await runTransitionEvent(scenario.event)

    const beforePromotion = await transitionSnapshot()
    await promoteStaleMmsHeaders(
      env.DB,
      Date.now() + MMS_DOWNLOAD_WAIT_MS + 1_000,
    )
    const promoted = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM mo_failures
       WHERE error_text = ?`,
    )
      .bind(MMS_DOWNLOAD_MISSING_ERROR_TEXT)
      .first<{ count: number }>()

    expect({
      ...beforePromotion,
      promoted: promoted?.count,
    }).toEqual(scenario.expected)
  })
})
