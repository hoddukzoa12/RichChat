import { env, SELF } from 'cloudflare:test'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const NOW = Date.UTC(2026, 6, 28, 3, 0, 0)
const REPORT_DATE = '2026-07-28T12:00:00'

interface MessageRow {
  delivered_at: number | null
  delivery_status: string
  error_text: string | null
  msg_key: string | null
  result_code: string | null
}

function webhookItem(
  suffix: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cliKey: `report-client-${suffix}`,
    msgKey: `report-msg-${suffix}`,
    resultCode: '10000',
    resultCodeDesc: '성공',
    rptDt: REPORT_DATE,
    ...overrides,
  }
}

async function post(
  body: unknown,
  secret = env.LGU_REPORT_WEBHOOK_SECRET,
): Promise<Response> {
  return await SELF.fetch(
    `https://example.com/api/hooks/lgu/report/${encodeURIComponent(secret)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body:
        typeof body === 'string'
          ? body
          : JSON.stringify(body),
    },
  )
}

async function seedMessage(
  suffix: string,
  options: {
    deliveryStatus?: '대기' | '접수' | '전송중' | '완료' | '실패'
    msgKey?: string | null
  } = {},
): Promise<string> {
  const officeId = `report-office-${suffix}`
  const userId = `report-user-${suffix}`
  const customerId = `report-customer-${suffix}`
  const conversationId = `report-conversation-${suffix}`
  const messageId = `report-message-${suffix}`
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', NOW),
    env.DB.prepare(
      `INSERT INTO users (
         id, office_id, email, name, title, role, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    ).bind(
      userId,
      officeId,
      `${suffix}@rich.test`,
      '리포트 담당자',
      '매니저',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
         id, office_id, phone_e164, name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      `+8210${suffix.replaceAll(/\D/g, '').padStart(8, '0').slice(-8)}`,
      '리포트 고객',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
         id, office_id, customer_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(conversationId, officeId, customerId, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO messages (
         id, office_id, conversation_id, direction, channel, body,
         sender_user_id, occurred_at, created_at, client_key, msg_key,
         delivery_status
       ) VALUES (?, ?, ?, 'out', 'SMS', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      messageId,
      officeId,
      conversationId,
      '발송 본문',
      userId,
      NOW,
      NOW,
      `report-client-${suffix}`,
      options.msgKey === undefined
        ? `report-msg-${suffix}`
        : options.msgKey,
      options.deliveryStatus ?? '접수',
    ),
  ])
  return messageId
}

async function messageRow(messageId: string): Promise<MessageRow | null> {
  return await env.DB
    .prepare(
      `SELECT
         delivery_status, result_code, delivered_at, error_text, msg_key
       FROM messages
       WHERE id = ?`,
    )
    .bind(messageId)
    .first<MessageRow>()
}

async function eventCount(messageId: string): Promise<number> {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS count
       FROM events
       WHERE type = 'message.delivery_updated'
         AND entity = 'message'
         AND entity_id = ?`,
    )
    .bind(messageId)
    .first<{ count: number }>()
  return row?.count ?? 0
}

async function expectAck(response: Response): Promise<void> {
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    code: '10000',
    message: 'success',
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LGU+ delivery report webhook', () => {
  it('commits a completed report before acknowledging it', async () => {
    const messageId = await seedMessage('101')

    const response = await post({
      rptCnt: 1,
      rptLst: [webhookItem('101')],
    })

    await expectAck(response)
    expect(await messageRow(messageId)).toEqual({
      delivered_at: Date.UTC(2026, 6, 28, 3, 0, 0),
      delivery_status: '완료',
      error_text: null,
      msg_key: 'report-msg-101',
      result_code: '10000',
    })
    expect(await eventCount(messageId)).toBe(1)
  })

  it('applies a duplicate report and its event only once', async () => {
    const messageId = await seedMessage('102')
    const body = {
      rptCnt: 1,
      rptLst: [webhookItem('102')],
    }

    await expectAck(await post(body))
    await expectAck(await post(body))

    expect((await messageRow(messageId))?.delivery_status).toBe('완료')
    expect(await eventCount(messageId)).toBe(1)
  })

  it('does not move a completed report backward to in progress', async () => {
    const messageId = await seedMessage('103')

    await expectAck(
      await post({
        rptCnt: 1,
        rptLst: [webhookItem('103')],
      }),
    )
    await expectAck(
      await post({
        rptCnt: 1,
        rptLst: [
          webhookItem('103', {
            status: 'ING',
            resultCode: undefined,
            resultCodeDesc: undefined,
            rptDt: undefined,
          }),
        ],
      }),
    )

    expect((await messageRow(messageId))?.delivery_status).toBe('완료')
    expect(await eventCount(messageId)).toBe(1)
  })

  it('stores a failed report with its provider details', async () => {
    const messageId = await seedMessage('104')

    await expectAck(
      await post({
        rptCnt: 1,
        rptLst: [
          webhookItem('104', {
            resultCode: '41010',
            resultCodeDesc: '단말기 전원 꺼짐',
          }),
        ],
      }),
    )

    expect(await messageRow(messageId)).toEqual({
      delivered_at: null,
      delivery_status: '실패',
      error_text: '단말기 전원 꺼짐',
      msg_key: 'report-msg-104',
      result_code: '41010',
    })
    expect(await eventCount(messageId)).toBe(1)
  })

  it('binds a report to a pending client key when msgKey is not stored yet', async () => {
    const messageId = await seedMessage('105', {
      deliveryStatus: '대기',
      msgKey: null,
    })

    await expectAck(
      await post({
        rptCnt: 1,
        rptLst: [webhookItem('105')],
      }),
    )

    expect(await messageRow(messageId)).toMatchObject({
      delivery_status: '완료',
      msg_key: 'report-msg-105',
    })
  })

  it('requests a retry for an unknown report key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = await post({
      rptCnt: 1,
      rptLst: [webhookItem('unknown')],
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: '99999',
      message: 'retry',
    })
  })

  it('quarantines a deterministic item while committing its valid sibling', async () => {
    const messageId = await seedMessage('106')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expectAck(
      await post({
        rptCnt: 2,
        rptLst: [
          webhookItem('106'),
          webhookItem('poison', { status: 'UNKNOWN' }),
        ],
      }),
    )

    expect((await messageRow(messageId))?.delivery_status).toBe('완료')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('격리'),
      expect.objectContaining({
        msgKey: 'report-msg-poison',
        receivedStatus: 'UNKNOWN',
        reason: expect.any(String),
      }),
    )
  })

  it('retries a transient D1 failure without quarantining it', async () => {
    const messageId = await seedMessage('107')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await env.DB.prepare(
      `CREATE TRIGGER fail_test_report
       BEFORE UPDATE OF delivery_status ON messages
       WHEN OLD.id = 'report-message-107'
       BEGIN
         SELECT RAISE(FAIL, 'forced report failure');
       END`,
    ).run()

    const first = await post({
      rptCnt: 1,
      rptLst: [webhookItem('107')],
    })

    expect(first.status).toBe(500)
    expect((await messageRow(messageId))?.delivery_status).toBe('접수')
    expect(await eventCount(messageId)).toBe(0)
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('격리'),
      expect.anything(),
    )

    await env.DB.prepare('DROP TRIGGER fail_test_report').run()
    await expectAck(
      await post({
        rptCnt: 1,
        rptLst: [webhookItem('107')],
      }),
    )
    expect((await messageRow(messageId))?.delivery_status).toBe('완료')
  })

  it('hides the route for wrong and MO webhook secrets', async () => {
    const body = { rptCnt: 0, rptLst: [] }

    expect(
      (await post(body, 'wrong-secret')).status,
    ).toBe(404)
    expect(
      (await post(body, env.LGU_MO_WEBHOOK_SECRET)).status,
    ).toBe(404)
  })

  it('acknowledges malformed JSON so it cannot poison later traffic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expectAck(await post('{not-json'))

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('격리'),
      expect.objectContaining({
        reason: '요청 본문이 JSON 형식이 아닙니다.',
      }),
    )
  })
})
