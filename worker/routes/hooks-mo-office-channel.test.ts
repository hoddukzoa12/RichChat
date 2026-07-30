import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const OFFICE_ID = 'office-mo-channel-retry'
const CHANNEL_ID = 'office-channel-mo-retry'
const MO_KEY = 'mo-channel-retry'

function webhookBody(): string {
  return JSON.stringify({
    moCnt: 1,
    moLst: [
      {
        moKey: MO_KEY,
        moNumber: '15445367',
        moType: 'SMSMO',
        moCallback: '01022334455',
        moMsg: '기본 채널 등록 뒤 복구할 문의',
        moRecvDt: '20260730160000',
        contentInfoLst: null,
      },
    ],
  })
}

function post(): Promise<Response> {
  return SELF.fetch(
    `${ORIGIN}/api/hooks/lgu/mo/${env.LGU_MO_WEBHOOK_SECRET}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: webhookBody(),
    },
  )
}

describe('LGU+ MO office channel assignment', () => {
  it('retries without storing until a default channel is registered', async () => {
    const now = Date.now()
    await env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    )
      .bind(OFFICE_ID, '세무법인 리치', now)
      .run()

    const beforeRegistration = await post()

    expect(beforeRegistration.status).toBe(500)
    await expect(beforeRegistration.json()).resolves.toEqual({
      code: '99999',
      message: 'retry',
    })
    const missingMessage = await env.DB.prepare(
      'SELECT id FROM messages WHERE mo_key = ?',
    )
      .bind(MO_KEY)
      .first()
    expect(missingMessage).toBeNull()

    await env.DB.prepare(
      `INSERT INTO office_channels (
         id, office_id, value, label, is_default, active, created_at
       ) VALUES (?, ?, ?, ?, 1, 1, ?)`,
    )
      .bind(
        CHANNEL_ID,
        OFFICE_ID,
        '15445367',
        'LGU+ 업무폰',
        now,
      )
      .run()

    const afterRegistration = await post()

    expect(afterRegistration.status).toBe(200)
    await expect(afterRegistration.json()).resolves.toEqual({
      code: '10000',
      message: 'success',
    })
    const stored = await env.DB.prepare(
      `SELECT
         conversations.office_channel_id,
         conversations.inbound_count
       FROM messages
       INNER JOIN conversations
         ON conversations.id = messages.conversation_id
       WHERE messages.mo_key = ?`,
    )
      .bind(MO_KEY)
      .first<{
        office_channel_id: string
        inbound_count: number
      }>()
    expect(stored).toEqual({
      office_channel_id: CHANNEL_ID,
      inbound_count: 1,
    })
  })
})
