import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type {
  CustomerCard,
  CustomerVersionConflictResponse,
  UpdateCustomerResponse,
} from '../../shared/wire/card'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const INITIAL_TIME = 1_753_670_800_123

interface SeededCustomer {
  customerId: string
  fieldIds: [string, string, string]
  officeId: string
  tokens: [string, string]
  userIds: [string, string]
}

interface StoredCustomer {
  phone_e164: string
  name: string
  company: string
  role_title: string
  version: number
}

interface StoredField {
  id: string
  key: string
  value: string
  sort_order: number
}

let seedSequence = 0

async function seedCustomer(
  company = '(주)가나 · 다라',
): Promise<SeededCustomer> {
  seedSequence += 1
  const suffix = `customer-${seedSequence}`
  const officeId = `office-${suffix}`
  const customerId = `customer-${suffix}`
  const userIds: [string, string] = [
    `user-${suffix}-a`,
    `user-${suffix}-b`,
  ]
  const fieldIds: [string, string, string] = [
    `field-${suffix}-a`,
    `field-${suffix}-b`,
    `field-${suffix}-c`,
  ]

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', INITIAL_TIME),
    ...userIds.map((userId, index) =>
      env.DB
        .prepare(
          `INSERT INTO users (
            id,
            office_id,
            email,
            name,
            title,
            role,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
        )
        .bind(
          userId,
          officeId,
          `${suffix}-${index}@rich.example`,
          `상담원 ${index + 1}`,
          '상담 담당',
          INITIAL_TIME,
          INITIAL_TIME,
        ),
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id,
        office_id,
        phone_e164,
        name,
        company,
        role_title,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      '+821012345678',
      '김고객',
      company,
      '대표',
      INITIAL_TIME,
      INITIAL_TIME,
    ),
    ...fieldIds.map((fieldId, index) =>
      env.DB
        .prepare(
          `INSERT INTO customer_fields (
            id,
            customer_id,
            office_id,
            key,
            value,
            sort_order,
            updated_at,
            updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          fieldId,
          customerId,
          officeId,
          ['사업자번호', '업종', '기장료'][index],
          ['128-81-12345', '도소매', '월 33만원'][index],
          index,
          INITIAL_TIME,
          userIds[0],
        ),
    ),
  ])

  const sessions = await Promise.all(
    userIds.map((userId) =>
      createSession(env.DB, { userId, officeId }),
    ),
  )

  return {
    customerId,
    fieldIds,
    officeId,
    tokens: [sessions[0].token, sessions[1].token],
    userIds,
  }
}

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function patchCustomer(
  customerId: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/customers/${customerId}`, {
    method: 'PATCH',
    headers: {
      ...(token ? { cookie: cookie(token) } : {}),
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify(body),
  })
}

async function storedCustomer(
  customerId: string,
): Promise<StoredCustomer | null> {
  return env.DB.prepare(
    `SELECT phone_e164, name, company, role_title, version
    FROM customers
    WHERE id = ?`,
  )
    .bind(customerId)
    .first<StoredCustomer>()
}

async function storedFields(
  customerId: string,
): Promise<StoredField[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, key, value, sort_order
    FROM customer_fields
    WHERE customer_id = ?
    ORDER BY sort_order, id`,
  )
    .bind(customerId)
    .all<StoredField>()
  return results
}

async function eventCount(customerId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
    FROM events
    WHERE entity = 'customer' AND entity_id = ?`,
  )
    .bind(customerId)
    .first<{ count: number }>()
  return row?.count ?? 0
}

async function officeEventSequence(officeId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT event_seq FROM offices WHERE id = ?',
  )
    .bind(officeId)
    .first<{ event_seq: number }>()
  return row?.event_seq ?? 0
}

describe('Customer update API', () => {
  it('requires an authenticated session', async () => {
    const seeded = await seedCustomer()

    const response = await patchCustomer(seeded.customerId, {
      version: 1,
      name: '인증 없음',
    })

    expect(response.status).toBe(401)
    expect(await storedCustomer(seeded.customerId)).toMatchObject({
      name: '김고객',
      version: 1,
    })
  })

  it('rejects a stale second editor without changing customer fields', async () => {
    const seeded = await seedCustomer()

    // 두 세션이 모두 version 1을 읽은 뒤 첫 번째 세션이 먼저 저장한다.
    const first = await patchCustomer(
      seeded.customerId,
      {
        version: 1,
        name: '첫 번째 수정',
        fieldChanges: {
          update: [{ id: seeded.fieldIds[1], value: '전자상거래' }],
        },
      },
      seeded.tokens[0],
    )
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as UpdateCustomerResponse
    expect(firstBody.customer.version).toBe(2)

    const second = await patchCustomer(
      seeded.customerId,
      {
        version: 1,
        company: '두 번째 수정',
        fieldChanges: {
          create: [{ key: '담당자', value: '박상담', sortOrder: 3 }],
          delete: [seeded.fieldIds[0]],
        },
      },
      seeded.tokens[1],
    )

    expect(second.status).toBe(409)
    const conflict =
      (await second.json()) as CustomerVersionConflictResponse
    expect(conflict.error.code).toBe('CONFLICT_VERSION')
    expect(conflict.error.detail.current).toEqual(firstBody.customer)
    expect(await storedCustomer(seeded.customerId)).toMatchObject({
      name: '첫 번째 수정',
      company: '(주)가나 · 다라',
      version: 2,
    })
    expect(await storedFields(seeded.customerId)).toEqual([
      {
        id: seeded.fieldIds[0],
        key: '사업자번호',
        value: '128-81-12345',
        sort_order: 0,
      },
      {
        id: seeded.fieldIds[1],
        key: '업종',
        value: '전자상거래',
        sort_order: 1,
      },
      {
        id: seeded.fieldIds[2],
        key: '기장료',
        value: '월 33만원',
        sort_order: 2,
      },
    ])
    expect(await eventCount(seeded.customerId)).toBe(1)
    expect(await officeEventSequence(seeded.officeId)).toBe(1)
  })

  it('preserves omitted columns and keeps company separators intact', async () => {
    const seeded = await seedCustomer()

    const renamed = await patchCustomer(
      seeded.customerId,
      { version: 1, name: '이름만 수정' },
      seeded.tokens[0],
    )

    expect(renamed.status).toBe(200)
    await expect(renamed.json()).resolves.toMatchObject({
      customer: {
        name: '이름만 수정',
        company: '(주)가나 · 다라',
        roleTitle: '대표',
        version: 2,
      },
    })

    const cleared = await patchCustomer(
      seeded.customerId,
      { version: 2, company: '' },
      seeded.tokens[0],
    )

    expect(cleared.status).toBe(200)
    await expect(cleared.json()).resolves.toMatchObject({
      customer: {
        name: '이름만 수정',
        company: '',
        roleTitle: '대표',
        version: 3,
      },
    })
  })

  it('updates and deletes fields by id after the middle field is removed', async () => {
    const seeded = await seedCustomer()

    const response = await patchCustomer(
      seeded.customerId,
      {
        version: 1,
        fieldChanges: {
          update: [
            {
              id: seeded.fieldIds[0],
              value: '128-81-99999',
              sortOrder: 1,
            },
            {
              id: seeded.fieldIds[2],
              value: '월 44만원',
              sortOrder: 0,
            },
          ],
          delete: [seeded.fieldIds[1]],
        },
      },
      seeded.tokens[0],
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as UpdateCustomerResponse
    expect(body.customer.version).toBe(2)
    expect(body.customer.fields).toMatchObject([
      {
        id: seeded.fieldIds[2],
        key: '기장료',
        value: '월 44만원',
        sortOrder: 0,
      },
      {
        id: seeded.fieldIds[0],
        key: '사업자번호',
        value: '128-81-99999',
        sortOrder: 1,
      },
    ])
  })

  it('assigns an ULID to a new field and translates duplicate keys', async () => {
    const seeded = await seedCustomer()

    const created = await patchCustomer(
      seeded.customerId,
      {
        version: 1,
        fieldChanges: {
          create: [
            { key: '담당 세무사', value: '한세무', sortOrder: 3 },
          ],
        },
      },
      seeded.tokens[0],
    )

    expect(created.status).toBe(200)
    const createdBody = (await created.json()) as UpdateCustomerResponse
    const newField = createdBody.customer.fields.find(
      ({ key }) => key === '담당 세무사',
    )
    expect(newField?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(await eventCount(seeded.customerId)).toBe(1)

    const duplicate = await patchCustomer(
      seeded.customerId,
      {
        version: 2,
        fieldChanges: {
          create: [{ key: '기장료', value: '중복', sortOrder: 4 }],
        },
      },
      seeded.tokens[0],
    )

    expect(duplicate.status).toBe(409)
    expect(await storedCustomer(seeded.customerId)).toMatchObject({
      version: 2,
    })
    expect((await storedFields(seeded.customerId))).not.toContainEqual(
      expect.objectContaining({ value: '중복' }),
    )
    expect(await eventCount(seeded.customerId)).toBe(1)
  })

  it.each(['phoneE164', 'phone_e164'])(
    'never changes the identity phone sent as %s',
    async (phoneKey) => {
      const seeded = await seedCustomer()

      const response = await patchCustomer(
        seeded.customerId,
        {
          version: 1,
          name: '번호 변경 시도',
          [phoneKey]: '+821099999999',
        },
        seeded.tokens[0],
      )

      expect(response.status).toBe(400)
      expect(await storedCustomer(seeded.customerId)).toEqual({
        phone_e164: '+821012345678',
        name: '김고객',
        company: '(주)가나 · 다라',
        role_title: '대표',
        version: 1,
      })
      expect(await eventCount(seeded.customerId)).toBe(0)
    },
  )

  it('does not expose or update another office customer', async () => {
    const owner = await seedCustomer()
    const outsider = await seedCustomer()

    const response = await patchCustomer(
      owner.customerId,
      { version: 1, name: '다른 사무소 수정' },
      outsider.tokens[0],
    )

    expect(response.status).toBe(404)
    expect(await storedCustomer(owner.customerId)).toMatchObject({
      name: '김고객',
      version: 1,
    })
    expect(await eventCount(owner.customerId)).toBe(0)
  })

  it('returns the complete updated customer without masking its phone', async () => {
    const seeded = await seedCustomer()

    const response = await patchCustomer(
      seeded.customerId,
      { version: 1, roleTitle: '재무이사' },
      seeded.tokens[0],
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      customer: CustomerCard
    }
    expect(body.customer).toMatchObject({
      id: seeded.customerId,
      phoneE164: '+821012345678',
      name: '김고객',
      company: '(주)가나 · 다라',
      roleTitle: '재무이사',
      version: 2,
    })
    expect(body.customer.fields).toHaveLength(3)
    expect(await eventCount(seeded.customerId)).toBe(1)
  })
})
