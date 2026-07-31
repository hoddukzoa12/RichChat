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

    expect(queries).toHaveLength(3)
    expect(queries[0]).toMatch(
      /^CREATE TABLE sms_gateway_mms_pending/u,
    )
    expect(queries[1]).toMatch(
      /^CREATE INDEX ix_sms_gateway_mms_pending_match/u,
    )
    expect(queries[2]).toMatch(
      /^CREATE TABLE sms_gateway_mms_matches/u,
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
         WHERE name = 'sms_gateway_mms_matches'`,
      ).first(),
    ).toEqual({ strict: 1 })

    await env.DB.prepare(
      `INSERT INTO sms_gateway_mms_matches (
         downloaded_mo_key, received_mo_key, matched_at
       ) VALUES ('downloaded-1', 'received-1', 1)`,
    ).run()
    await expect(
      env.DB.prepare(
        `INSERT INTO sms_gateway_mms_matches (
           downloaded_mo_key, received_mo_key, matched_at
         ) VALUES ('downloaded-1', 'received-2', 2)`,
      ).run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `INSERT INTO sms_gateway_mms_matches (
           downloaded_mo_key, received_mo_key, matched_at
         ) VALUES ('downloaded-2', 'received-1', 2)`,
      ).run(),
    ).rejects.toThrow()
  })
})
