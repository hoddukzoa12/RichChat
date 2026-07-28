import { env } from 'cloudflare:test'
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { LguFetch } from './lgu/protocol'
import {
  PENDING_DELIVERY_REPORT_QUERY,
  REPORT_RECONCILIATION_AGE_MS,
  runDeliveryReportReconciliation,
} from './scheduled'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const NOW = Date.UTC(2026, 6, 28, 3, 0, 0)
const TOKEN = 'report-reconciliation-token'

interface MessageRow {
  delivered_at: number | null
  delivery_status: string
  msg_key: string | null
}

function logger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  }
}

function lguResponse(items: readonly Record<string, unknown>[]): Response {
  return new Response(
    JSON.stringify({
      code: '10000',
      message: '성공',
      data: { cliKeyLst: items },
    }),
    {
      headers: { 'content-type': 'application/json' },
    },
  )
}

async function seedPending(
  suffix: string,
  createdAt: number,
  deliveryStatus: '대기' | '접수' | '전송중' = '대기',
): Promise<string> {
  const officeId = `reconcile-office-${suffix}`
  const userId = `reconcile-user-${suffix}`
  const customerId = `reconcile-customer-${suffix}`
  const conversationId = `reconcile-conversation-${suffix}`
  const messageId = `reconcile-message-${suffix}`
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', createdAt),
    env.DB.prepare(
      `INSERT INTO users (
         id, office_id, email, name, title, role, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    ).bind(
      userId,
      officeId,
      `${suffix}@reconcile.test`,
      '보정 담당자',
      '매니저',
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
         id, office_id, phone_e164, name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      `+8210${suffix.replaceAll(/\D/g, '').padStart(8, '0').slice(-8)}`,
      '보정 고객',
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
         id, office_id, customer_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      conversationId,
      officeId,
      customerId,
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO messages (
         id, office_id, conversation_id, direction, channel, body,
         sender_user_id, occurred_at, created_at, client_key, msg_key,
         delivery_status
       ) VALUES (?, ?, ?, 'out', 'SMS', ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      messageId,
      officeId,
      conversationId,
      'Cron 보정 본문',
      userId,
      createdAt,
      createdAt,
      `reconcile-client-${suffix}`,
      deliveryStatus,
    ),
  ])
  return messageId
}

async function messageRow(messageId: string): Promise<MessageRow | null> {
  return await env.DB
    .prepare(
      `SELECT delivery_status, delivered_at, msg_key
       FROM messages
       WHERE id = ?`,
    )
    .bind(messageId)
    .first<MessageRow>()
}

function options(fetcher: LguFetch) {
  return {
    fetch: fetcher,
    logger: logger(),
    now: () => NOW,
    tokenProvider: async () => TOKEN,
  }
}

describe('LGU+ scheduled delivery reconciliation', () => {
  it('does not call LGU+ when no pending message is old enough', async () => {
    const fetcher = vi.fn<LguFetch>()
    const tokenProvider = vi.fn(async () => TOKEN)

    const summary = await runDeliveryReportReconciliation(env, {
      fetch: fetcher,
      logger: logger(),
      now: () => NOW,
      tokenProvider,
    })

    expect(summary).toEqual({
      changed: 0,
      queried: 0,
      rejected: 0,
      unchanged: 0,
      unknown: 0,
    })
    expect(tokenProvider).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not query a message younger than two minutes', async () => {
    const messageId = await seedPending(
      '201',
      NOW - REPORT_RECONCILIATION_AGE_MS + 1,
    )
    const fetcher = vi.fn<LguFetch>()

    const summary = await runDeliveryReportReconciliation(
      env,
      options(fetcher),
    )

    expect(summary.queried).toBe(0)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await messageRow(messageId))?.delivery_status).toBe('대기')

    await env.DB.prepare(
      `UPDATE messages
       SET delivery_status = '실패'
       WHERE id = ? AND delivery_status = '대기'`,
    )
      .bind(messageId)
      .run()
  })

  it('queries an old pending message and stores the completed result', async () => {
    const createdAt = NOW - REPORT_RECONCILIATION_AGE_MS
    const messageId = await seedPending('202', createdAt)
    const requests: Array<{
      authorization: string | null
      body: unknown
      url: string
    }> = []
    const fetcher: LguFetch = async (input, init) => {
      requests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
        url: String(input),
      })
      return lguResponse([
        {
          cliKey: 'reconcile-client-202',
          msgKey: 'reconcile-msg-202',
          status: 'DONE',
          resultCode: '10000',
          resultCodeDesc: '성공',
          rptDt: '2026-07-28T12:00:00',
        },
      ])
    }

    const summary = await runDeliveryReportReconciliation(
      env,
      options(fetcher),
    )

    expect(summary).toEqual({
      changed: 1,
      queried: 1,
      rejected: 0,
      unchanged: 0,
      unknown: 0,
    })
    expect(requests).toEqual([
      {
        authorization: `Bearer ${TOKEN}`,
        body: {
          cliKeyLst: [
            {
              cliKey: 'reconcile-client-202',
              reqDt: '2026-07-28',
            },
          ],
        },
        url: `https://${env.LGU_AUTH_HOST}/msg/v1/sent`,
      },
    ])
    expect(await messageRow(messageId)).toEqual({
      delivered_at: NOW,
      delivery_status: '완료',
      msg_key: 'reconcile-msg-202',
    })
  })

  it('moves an accepted message to in progress without finalizing it', async () => {
    const messageId = await seedPending(
      '203',
      NOW - REPORT_RECONCILIATION_AGE_MS - 1,
      '접수',
    )
    const fetcher: LguFetch = async () =>
      lguResponse([
        {
          cliKey: 'reconcile-client-203',
          msgKey: 'reconcile-msg-203',
          status: 'ING',
        },
      ])

    const summary = await runDeliveryReportReconciliation(
      env,
      options(fetcher),
    )

    expect(summary.changed).toBe(1)
    expect(await messageRow(messageId)).toEqual({
      delivered_at: null,
      delivery_status: '전송중',
      msg_key: 'reconcile-msg-203',
    })

    await env.DB.prepare(
      `UPDATE messages
       SET delivery_status = '실패'
       WHERE id = ? AND delivery_status = '전송중'`,
    )
      .bind(messageId)
      .run()
  })

  it('isolates an invalid status while applying its valid sibling', async () => {
    const createdAt = NOW - REPORT_RECONCILIATION_AGE_MS - 1
    const invalidMessageId = await seedPending('204', createdAt)
    const validMessageId = await seedPending('205', createdAt)
    const testLogger = logger()
    const fetcher: LguFetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        cliKeyLst: Array<{ cliKey: string }>
      }
      return lguResponse(
        request.cliKeyLst.map(({ cliKey }) =>
          cliKey.endsWith('204')
            ? {
                cliKey,
                msgKey: 'reconcile-msg-204',
                status: 'MYSTERY',
              }
            : {
                cliKey,
                msgKey: 'reconcile-msg-205',
                status: 'DONE',
                resultCode: '10000',
                resultCodeDesc: '성공',
                rptDt: '2026-07-28T12:00:00',
              },
        ),
      )
    }

    const summary = await runDeliveryReportReconciliation(env, {
      ...options(fetcher),
      logger: testLogger,
    })

    expect(summary).toMatchObject({
      changed: 1,
      queried: 2,
      rejected: 1,
    })
    expect((await messageRow(invalidMessageId))?.delivery_status).toBe(
      '대기',
    )
    expect((await messageRow(validMessageId))?.delivery_status).toBe(
      '완료',
    )
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('격리'),
      expect.objectContaining({
        msgKey: 'reconcile-msg-204',
        receivedStatus: 'MYSTERY',
      }),
    )

    await env.DB.prepare(
      `UPDATE messages
       SET delivery_status = '실패'
       WHERE id = ? AND delivery_status = '대기'`,
    )
      .bind(invalidMessageId)
      .run()
  })

  it('uses the partial pending-message index', async () => {
    const plan = await env.DB
      .prepare(`EXPLAIN QUERY PLAN ${PENDING_DELIVERY_REPORT_QUERY}`)
      .bind(
        NOW - REPORT_RECONCILIATION_AGE_MS,
        10,
      )
      .all<{ detail: string }>()

    expect(plan.results.map((row) => row.detail).join('\n')).toContain(
      'ix_messages_pending',
    )
  })
})
