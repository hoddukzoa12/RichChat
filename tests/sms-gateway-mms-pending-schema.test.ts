import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('SMS Gateway MMS pending migration', () => {
  it('creates a strict diagnostics table without rebuilding existing tables', async () => {
    const migration = env.TEST_MIGRATIONS[11]
    if (migration === undefined) {
      throw new Error('0012 마이그레이션을 찾지 못했습니다.')
    }
    const queries = migration.queries.map((query) =>
      query.replace(/\s+/g, ' ').trim(),
    )

    expect(queries).toHaveLength(4)
    expect(queries[0]).toMatch(
      /^CREATE TABLE sms_gateway_mms_pending/u,
    )
    expect(queries[1]).toMatch(
      /^CREATE INDEX ix_sms_gateway_mms_pending_match/u,
    )
    expect(queries[2]).toMatch(
      /^CREATE TABLE sms_gateway_mms_downloaded/u,
    )
    expect(queries[3]).toMatch(
      /^CREATE INDEX ix_sms_gateway_mms_downloaded_match/u,
    )
    expect(queries.every((query) => !query.includes('DROP TABLE'))).toBe(
      true,
    )
    expect(
      await env.DB.prepare(
        `SELECT strict
         FROM pragma_table_list
         WHERE name = 'sms_gateway_mms_pending'`,
      ).first(),
    ).toEqual({ strict: 1 })
    expect(
      await env.DB.prepare(
        `SELECT strict
         FROM pragma_table_list
         WHERE name = 'sms_gateway_mms_downloaded'`,
      ).first(),
    ).toEqual({ strict: 1 })
    expect(
      await env.DB.prepare(
        `SELECT "notnull", dflt_value
         FROM pragma_table_info('sms_gateway_mms_downloaded')
         WHERE name = 'consumed'`,
      ).first(),
    ).toEqual({ dflt_value: '0', notnull: 1 })
    expect(
      await env.DB.prepare(
        `SELECT "notnull", dflt_value
         FROM pragma_table_info('sms_gateway_mms_downloaded')
         WHERE name = 'received_mo_key'`,
      ).first(),
    ).toEqual({ dflt_value: null, notnull: 0 })
    await expect(
      env.DB.prepare(
        `INSERT INTO sms_gateway_mms_downloaded (
           mo_key, device_id, sender_e164, downloaded_at, consumed
         ) VALUES ('invalid-consumed', 'device', '+821000000000', 1, 1)`,
      ).run(),
    ).rejects.toThrow()
  })
})
