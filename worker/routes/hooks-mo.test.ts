import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  INVALID_ITEM_KEY_PREFIX,
  parseMoRecvDt,
} from './hooks-mo'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const OFFICE_NAME = '세무법인 리치'

interface MoInput {
  moKey: string
  moCallback?: string
  moType?: 'SMSMO' | 'MMSMO' | 'RCSMO'
  moMsg?: string
  moRecvDt?: string
  contentInfoLst?: Array<{
    contentName: string
    contentSize: number | string
    contentExt: string
    contentUrl: string
  }>
}

function kstTimestamp(epoch = Date.now()): string {
  const kst = new Date(epoch + 9 * 60 * 60 * 1_000)
  return kst
    .toISOString()
    .replace(/\D/g, '')
    .slice(0, 14)
}

function mo(input: MoInput) {
  const contentInfoLst = input.contentInfoLst ?? []
  return {
    moKey: input.moKey,
    moNumber: '15445367',
    moType: input.moType ?? 'SMSMO',
    moCallback: input.moCallback ?? '01022334455',
    moMsg: input.moMsg ?? '부가세 문의드려요',
    telco: 'LGU',
    moRecvDt: input.moRecvDt ?? kstTimestamp(),
    contentCnt: contentInfoLst.length,
    contentInfoLst,
  }
}

function payload(...items: unknown[]): string {
  return JSON.stringify({ moCnt: items.length, moLst: items })
}

function hookUrl(secret = env.LGU_MO_WEBHOOK_SECRET): string {
  return `${ORIGIN}/api/hooks/lgu/mo/${encodeURIComponent(secret)}`
}

function post(body: string, secret?: string): Promise<Response> {
  return SELF.fetch(hookUrl(secret), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

async function insertOffice(id: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
  )
    .bind(id, OFFICE_NAME, Date.now())
    .run()
}

async function expectSuccess(response: Response): Promise<void> {
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    code: '10000',
    message: 'success',
  })
}

async function expectRetry(
  response: Response,
  status = 500,
): Promise<void> {
  expect(response.status).toBe(status)
  await expect(response.json()).resolves.toEqual({
    code: '99999',
    message: 'retry',
  })
}

describe('LGU+ MO webhook', () => {
  it('commits a new customer conversation and idempotent message before ack', async () => {
    await insertOffice('office-mo-idempotent')
    const body = payload(mo({ moKey: 'mo-idempotent' }))

    await expectSuccess(await post(body))
    await expectSuccess(await post(body))
    await expectSuccess(
      await post(
        payload(
          mo({
            moKey: 'mo-idempotent',
            moCallback: '01099998888',
          }),
        ),
      ),
    )

    const customer = await env.DB.prepare(
      `SELECT COUNT(*) AS count, MIN(phone_e164) AS phone_e164
       FROM customers
       WHERE office_id = ?`,
    )
      .bind('office-mo-idempotent')
      .first<{ count: number; phone_e164: string }>()
    const conversation = await env.DB.prepare(
      `SELECT
         COUNT(*) AS count,
         MIN(status) AS status,
         MIN(inbound_count) AS inbound_count
       FROM conversations
       WHERE office_id = ?`,
    )
      .bind('office-mo-idempotent')
      .first<{ count: number; status: string; inbound_count: number }>()
    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE mo_key = ?',
    )
      .bind('mo-idempotent')
      .first<{ count: number }>()
    const eventCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM events WHERE office_id = ?',
    )
      .bind('office-mo-idempotent')
      .first<{ count: number }>()

    expect(customer).toEqual({
      count: 1,
      phone_e164: '+821022334455',
    })
    expect(conversation).toEqual({
      count: 1,
      status: '미처리',
      inbound_count: 1,
    })
    expect(messageCount?.count).toBe(1)
    expect(eventCount?.count).toBe(1)
  })

  it('sorts a reversed payload by the KST receive timestamp', async () => {
    await insertOffice('office-mo-order')
    const now = Date.now()
    const older = mo({
      moKey: 'mo-order-older',
      moMsg: '먼저 온 메시지',
      moRecvDt: kstTimestamp(now - 2_000),
    })
    const newer = mo({
      moKey: 'mo-order-newer',
      moMsg: '나중에 온 메시지',
      moRecvDt: kstTimestamp(now - 1_000),
    })

    await expectSuccess(await post(payload(newer, older)))

    const { results } = await env.DB.prepare(
      `SELECT body
       FROM messages
       WHERE office_id = ?
       ORDER BY occurred_at, id`,
    )
      .bind('office-mo-order')
      .all<{ body: string }>()

    expect(results.map((row) => row.body)).toEqual([
      '먼저 온 메시지',
      '나중에 온 메시지',
    ])
  })

  it('does not move the last message pointer backward across requests', async () => {
    await insertOffice('office-mo-pointer')
    const now = Date.now()
    const newer = mo({
      moKey: 'mo-pointer-newer',
      moMsg: '최신 메시지',
      moRecvDt: kstTimestamp(now - 1_000),
    })
    const older = mo({
      moKey: 'mo-pointer-older',
      moMsg: '늦게 도착한 과거 메시지',
      moRecvDt: kstTimestamp(now - 2_000),
    })

    await expectSuccess(await post(payload(newer)))
    await expectSuccess(await post(payload(older)))

    const conversation = await env.DB.prepare(
      `SELECT messages.body, conversations.inbound_count
       FROM conversations
       JOIN messages ON messages.id = conversations.last_message_id
       WHERE conversations.office_id = ?`,
    )
      .bind('office-mo-pointer')
      .first<{ body: string; inbound_count: number }>()

    expect(conversation).toEqual({
      body: '최신 메시지',
      inbound_count: 2,
    })
  })

  it('applies inbound status transitions to existing conversations', async () => {
    const officeId = 'office-mo-reopen'
    const completedCustomerId = 'customer-mo-reopen'
    const doingCustomerId = 'customer-mo-doing'
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
      ).bind(officeId, OFFICE_NAME, Date.now()),
      env.DB.prepare(
        `INSERT INTO customers (
           id, office_id, phone_e164, name, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        completedCustomerId,
        officeId,
        '+821022334455',
        '완료 고객',
        Date.now(),
        Date.now(),
      ),
      env.DB.prepare(
        `INSERT INTO customers (
           id, office_id, phone_e164, name, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        doingCustomerId,
        officeId,
        '+821033344455',
        '처리중 고객',
        Date.now(),
        Date.now(),
      ),
      env.DB.prepare(
        `INSERT INTO conversations (
           id, office_id, customer_id, status, created_at, updated_at
         )
         VALUES (?, ?, ?, '완료', ?, ?)`,
      ).bind(
        'conversation-mo-reopen',
        officeId,
        completedCustomerId,
        Date.now(),
        Date.now(),
      ),
      env.DB.prepare(
        `INSERT INTO conversations (
           id, office_id, customer_id, status, created_at, updated_at
         )
         VALUES (?, ?, ?, '처리중', ?, ?)`,
      ).bind(
        'conversation-mo-doing',
        officeId,
        doingCustomerId,
        Date.now(),
        Date.now(),
      ),
    ])

    await expectSuccess(
      await post(
        payload(
          mo({ moKey: 'mo-reopen' }),
          mo({
            moKey: 'mo-doing',
            moCallback: '01033344455',
          }),
        ),
      ),
    )

    const { results } = await env.DB.prepare(
      `SELECT id, status
       FROM conversations
       WHERE office_id = ?
       ORDER BY id`,
    )
      .bind(officeId)
      .all<{ id: string; status: string }>()
    expect(results).toEqual([
      { id: 'conversation-mo-doing', status: '처리중' },
      { id: 'conversation-mo-reopen', status: '미처리' },
    ])
  })

  it('quarantines the third deterministic payload failure', async () => {
    await insertOffice('office-mo-deterministic-poison')
    const body = payload(
      mo({
        moKey: 'mo-deterministic-poison',
        moRecvDt: '20260229000000',
      }),
    )

    await expectRetry(await post(body), 400)
    await expectRetry(await post(body), 400)
    await expectSuccess(await post(body))

    const failure = await env.DB.prepare(
      'SELECT attempts, raw_json FROM mo_failures WHERE mo_key = ?',
    )
      .bind('mo-deterministic-poison')
      .first<{ attempts: number; raw_json: string }>()
    const message = await env.DB.prepare(
      'SELECT id FROM messages WHERE mo_key = ?',
    )
      .bind('mo-deterministic-poison')
      .first<{ id: string }>()

    expect(failure?.attempts).toBe(3)
    expect(JSON.parse(failure?.raw_json ?? '{}')).toMatchObject({
      moKey: 'mo-deterministic-poison',
      moRecvDt: '20260229000000',
    })
    expect(message).toBeNull()
  })

  it('never quarantines transient D1 failures and stores after recovery', async () => {
    await insertOffice('office-mo-transient')
    await env.DB.prepare(
      `CREATE TRIGGER fail_test_mo
       BEFORE INSERT ON messages
       WHEN NEW.mo_key = 'mo-transient'
       BEGIN
         SELECT RAISE(FAIL, 'forced test failure');
       END`,
    ).run()
    const body = payload(mo({ moKey: 'mo-transient' }))

    const first = await post(body)
    const second = await post(body)
    const third = await post(body)

    await expectRetry(first)
    await expectRetry(second)
    await expectRetry(third)

    const failuresDuringOutage = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM mo_failures',
    ).first<{ count: number }>()
    expect(failuresDuringOutage?.count).toBe(0)

    await env.DB.prepare('DROP TRIGGER fail_test_mo').run()
    await expectSuccess(await post(body))

    const message = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE mo_key = ?',
    )
      .bind('mo-transient')
      .first<{ count: number }>()
    const failuresAfterRecovery = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM mo_failures',
    ).first<{ count: number }>()

    expect(message?.count).toBe(1)
    expect(failuresAfterRecovery?.count).toBe(0)
  })

  it('uses a stable synthetic key so a missing moKey cannot block siblings', async () => {
    await insertOffice('office-mo-missing-key')
    const valid = mo({
      moKey: 'mo-valid-sibling',
      moCallback: '01077776666',
    })
    const invalid: Record<string, unknown> = {
      ...mo({ moKey: 'removed-before-post' }),
    }
    delete invalid.moKey
    const reorderedInvalid = Object.fromEntries(
      Object.entries(invalid).reverse(),
    )
    const originalOrderBody = payload(valid, invalid)

    await expectRetry(await post(originalOrderBody), 400)
    await expectRetry(await post(originalOrderBody), 400)
    await expectSuccess(await post(originalOrderBody))
    await expectSuccess(await post(payload(valid, reorderedInvalid)))

    const conversation = await env.DB.prepare(
      `SELECT conversations.inbound_count
       FROM conversations
       JOIN customers ON customers.id = conversations.customer_id
       WHERE customers.phone_e164 = ?`,
    )
      .bind('+821077776666')
      .first<{ inbound_count: number }>()
    const message = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE mo_key = ?',
    )
      .bind('mo-valid-sibling')
      .first<{ count: number }>()
    const { results: failures } = await env.DB.prepare(
      `SELECT mo_key, attempts, raw_json
       FROM mo_failures
       WHERE mo_key LIKE ?`,
    )
      .bind(`${INVALID_ITEM_KEY_PREFIX}%`)
      .all<{
        mo_key: string
        attempts: number
        raw_json: string
      }>()

    expect(conversation?.inbound_count).toBe(1)
    expect(message?.count).toBe(1)
    expect(failures).toHaveLength(1)
    expect(failures[0].mo_key.startsWith(INVALID_ITEM_KEY_PREFIX)).toBe(
      true,
    )
    expect(
      failures[0].mo_key.slice(INVALID_ITEM_KEY_PREFIX.length),
    ).toMatch(/^[0-9a-f]{64}$/)
    expect(failures[0].attempts).toBe(3)
    expect(JSON.parse(failures[0].raw_json)).not.toHaveProperty('moKey')
  })

  it('hides the webhook route when the secret is wrong', async () => {
    const response = await post(
      payload(mo({ moKey: 'mo-wrong-secret' })),
      'wrong-secret',
    )

    expect(response.status).toBe(404)
  })

  it('parses the KST year boundary without relying on Date string parsing', () => {
    expect(parseMoRecvDt('20260101000000')).toBe(
      Date.UTC(2025, 11, 31, 15, 0, 0),
    )
    expect(parseMoRecvDt('20260229000000')).toBeNull()
  })

  it('preserves an old valid timestamp without promoting a delayed message', async () => {
    await insertOffice('office-mo-delayed')
    const now = Date.now()
    const currentTimestamp = kstTimestamp(now - 1_000)
    const oldTimestamp = kstTimestamp(now - 2 * 24 * 60 * 60 * 1_000)

    await expectSuccess(
      await post(
        payload(
          mo({
            moKey: 'mo-current',
            moMsg: '현재 최신 메시지',
            moRecvDt: currentTimestamp,
          }),
        ),
      ),
    )
    await expectSuccess(
      await post(
        payload(
          mo({
            moKey: 'mo-two-days-old',
            moMsg: '이틀 전 지연 메시지',
            moRecvDt: oldTimestamp,
          }),
        ),
      ),
    )

    const delayed = await env.DB.prepare(
      'SELECT occurred_at FROM messages WHERE mo_key = ?',
    )
      .bind('mo-two-days-old')
      .first<{ occurred_at: number }>()
    const conversation = await env.DB.prepare(
      `SELECT messages.body, conversations.last_message_at
       FROM conversations
       JOIN messages ON messages.id = conversations.last_message_id
       WHERE conversations.office_id = ?`,
    )
      .bind('office-mo-delayed')
      .first<{ body: string; last_message_at: number }>()

    expect(delayed?.occurred_at).toBe(parseMoRecvDt(oldTimestamp))
    expect(conversation).toEqual({
      body: '현재 최신 메시지',
      last_message_at: parseMoRecvDt(currentTimestamp),
    })
  })

  it('stores attachment metadata in the pending state', async () => {
    await insertOffice('office-mo-attachment')
    const item = mo({
      moKey: 'mo-attachment',
      moType: 'MMSMO',
      contentInfoLst: [
        {
          contentName: '영수증',
          contentSize: '1024',
          contentExt: 'jpg',
          contentUrl: 'https://example.com/one-time-content',
        },
      ],
    })

    await expectSuccess(await post(payload(item)))

    const attachment = await env.DB.prepare(
      `SELECT original_filename, byte_size, mime_type, r2_key, download_status
       FROM message_attachments`,
    ).first<{
      original_filename: string
      byte_size: number
      mime_type: string
      r2_key: string | null
      download_status: string
    }>()

    expect(attachment).toEqual({
      original_filename: '영수증.jpg',
      byte_size: 1024,
      mime_type: 'image/jpeg',
      r2_key: null,
      download_status: '대기',
    })
  })

  it('keeps an unexpected RCS inbound visible by storing it as MMS', async () => {
    await insertOffice('office-mo-rcs')

    await expectSuccess(
      await post(payload(mo({ moKey: 'mo-rcs', moType: 'RCSMO' }))),
    )

    const message = await env.DB.prepare(
      'SELECT channel FROM messages WHERE mo_key = ?',
    )
      .bind('mo-rcs')
      .first<{ channel: string }>()
    expect(message?.channel).toBe('MMS')
  })
})
