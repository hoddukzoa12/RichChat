import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Role } from '../../shared/domain'
import type {
  OfficePhoneResponse,
  OfficePhoneSigningKeyResponse,
  OfficePhonesResponse,
} from '../../shared/wire/office'
import {
  TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID,
  TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE,
} from '../../tests/sms-gateway-fixtures'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

interface TestUser {
  id: string
  token: string
}

interface Fixture {
  officeId: string
  suffix: string
  admin: TestUser
}

interface StoredPhone {
  value: string
  label: string
  device_id: string | null
  is_default: number
  active: number
  signing_key: string | null
}

let fixtureSequence = 0

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function seedUser(
  fixture: Pick<Fixture, 'officeId' | 'suffix'>,
  role: Role,
  label: string,
): Promise<TestUser> {
  const id = `${label}-${fixture.suffix}`
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO users (
      id, office_id, email, name, title, role, status, created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '활성', ?, ?)`,
  )
    .bind(
      id,
      fixture.officeId,
      `${id}@rich.example`,
      label,
      `${label} 직함`,
      role,
      now,
      now,
    )
    .run()
  const session = await createSession(
    env.DB,
    { userId: id, officeId: fixture.officeId },
    now,
  )
  return { id, token: session.token }
}

async function seedFixture(): Promise<Fixture> {
  fixtureSequence += 1
  const suffix = `office-phone-${fixtureSequence}`
  const officeId = `office-${suffix}`
  const now = Date.now()
  await env.DB.prepare(
    'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
  )
    .bind(officeId, '세무법인 리치', now)
    .run()

  const fixture = {
    officeId,
    suffix,
  }
  const admin = await seedUser(fixture, '관리자', '관리자')
  return { ...fixture, admin }
}

async function seedPhone(
  fixture: Fixture,
  options: {
    id?: string
    value?: string
    label?: string
    deviceId?: string | null
    isDefault?: boolean
    active?: boolean
    signingKey?: string | null
  } = {},
): Promise<string> {
  const id = options.id ?? `phone-${fixture.suffix}`
  const deviceId = Object.hasOwn(options, 'deviceId')
    ? options.deviceId ?? null
    : `device-${fixture.suffix}`
  await env.DB.prepare(
    `INSERT INTO office_channels (
      id, office_id, value, label, device_id, is_default, active,
      created_at, signing_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      fixture.officeId,
      options.value ?? '01012345678',
      options.label ?? '업무폰 1',
      deviceId,
      Number(options.isDefault ?? false),
      Number(options.active ?? true),
      Date.now(),
      options.signingKey ?? null,
    )
    .run()
  return id
}

async function request(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN })
  if (token) headers.set('cookie', cookie(token))
  if (body !== undefined) {
    headers.set('content-type', 'application/json')
  }
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function storedPhone(phoneId: string): Promise<StoredPhone | null> {
  return env.DB.prepare(
    `SELECT
      value, label, device_id, is_default, active, signing_key
    FROM office_channels
    WHERE id = ?`,
  )
    .bind(phoneId)
    .first<StoredPhone>()
}

describe('Office phone administration', () => {
  it.each([
    {
      method: 'GET' as const,
      path: '/api/office/phones',
      body: undefined,
    },
    {
      method: 'POST' as const,
      path: '/api/office/phones',
      body: {
        value: '01011112222',
        label: '업무폰',
        deviceId: 'device-unauthenticated',
      },
    },
    {
      method: 'PATCH' as const,
      path: '/api/office/phones/phone-1',
      body: { label: '변경 라벨' },
    },
    {
      method: 'PATCH' as const,
      path: '/api/office/phones/phone-1/status',
      body: { active: false },
    },
    {
      method: 'POST' as const,
      path: '/api/office/phones/phone-1/signing-key',
      body: undefined,
    },
  ])(
    'rejects an unauthenticated $method $path request',
    async ({ method, path, body }) => {
      const response = await request(
        method,
        path,
        undefined,
        body,
      )
      expect(response.status).toBe(401)
    },
  )

  it('lists phones with signing-key state and never exposes a key', async () => {
    const fixture = await seedFixture()
    await seedPhone(fixture, {
      id: `default-${fixture.suffix}`,
      value: '18771239',
      label: '대표번호',
      deviceId: null,
      isDefault: true,
    })
    await seedPhone(fixture, {
      id: `configured-${fixture.suffix}`,
      deviceId: TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID,
      signingKey:
        TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE[
          TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID
        ],
    })
    await seedPhone(fixture, {
      id: `missing-${fixture.suffix}`,
      value: '01087654321',
      label: '업무폰 2',
      deviceId: `missing-device-${fixture.suffix}`,
    })

    const response = await request(
      'GET',
      '/api/office/phones',
      fixture.admin.token,
    )

    expect(response.status).toBe(200)
    const text = await response.text()
    for (const key of Object.values(
      TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE,
    )) {
      expect(text).not.toContain(key)
    }
    const payload = JSON.parse(text) as OfficePhonesResponse
    expect(payload.phones).toEqual([
      expect.objectContaining({
        value: '18771239',
        label: '대표번호',
        deviceId: null,
        isDefault: true,
        active: true,
        signingKeyStatus: '해당 없음',
      }),
      expect.objectContaining({
        deviceId: TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID,
        signingKeyStatus: '설정됨',
      }),
      expect.objectContaining({
        deviceId: `missing-device-${fixture.suffix}`,
        signingKeyStatus: '미설정',
      }),
    ])
  })

  it('creates a durable phone and reports a duplicate Device ID', async () => {
    const fixture = await seedFixture()
    await seedPhone(fixture, {
      id: `default-${fixture.suffix}`,
      value: '18771239',
      label: '대표번호',
      deviceId: null,
      isDefault: true,
    })
    const deviceId = `new-device-${fixture.suffix}`
    const body = {
      value: '01056129001',
      label: '업무폰 2',
      deviceId,
    }

    const created = await request(
      'POST',
      '/api/office/phones',
      fixture.admin.token,
      body,
    )
    const duplicate = await request(
      'POST',
      '/api/office/phones',
      fixture.admin.token,
      {
        ...body,
        value: '01099998888',
        label: '중복 업무폰',
      },
    )
    const refreshed = await request(
      'GET',
      '/api/office/phones',
      fixture.admin.token,
    )

    expect(created.status).toBe(201)
    await expect(created.json<OfficePhoneResponse>()).resolves
      .toMatchObject({
        phone: {
          value: body.value,
          label: body.label,
          deviceId,
          isDefault: false,
          active: true,
        },
      })
    expect(duplicate.status).toBe(409)
    await expect(duplicate.json()).resolves.toMatchObject({
      error: {
        code: 'CONFLICT',
        message: expect.stringContaining('이미 등록된 Device ID'),
      },
    })
    const payload = await refreshed.json<OfficePhonesResponse>()
    expect(
      payload.phones.filter((phone) => phone.deviceId === deviceId),
    ).toHaveLength(1)
  })

  it('issues a key once without exposing it through phones or events', async () => {
    const fixture = await seedFixture()
    const phoneId = await seedPhone(fixture)

    const issued = await request(
      'POST',
      `/api/office/phones/${phoneId}/signing-key`,
      fixture.admin.token,
    )

    expect(issued.status).toBe(200)
    expect(issued.headers.get('cache-control')).toBe('no-store')
    const text = await issued.text()
    const payload = JSON.parse(text) as OfficePhoneSigningKeyResponse
    expect(payload.signingKey).toMatch(/^[\da-f]{64}$/)
    expect(payload.phone.signingKeyStatus).toBe('설정됨')
    expect((await storedPhone(phoneId))?.signing_key).toBe(
      payload.signingKey,
    )

    const list = await request(
      'GET',
      '/api/office/phones',
      fixture.admin.token,
    )
    const updated = await request(
      'PATCH',
      `/api/office/phones/${phoneId}`,
      fixture.admin.token,
      { label: '키 발급 완료 업무폰' },
    )
    expect(await list.text()).not.toContain(payload.signingKey)
    expect(await updated.text()).not.toContain(payload.signingKey)

    const { results: events } = await env.DB.prepare(
      `SELECT payload
       FROM events
       WHERE office_id = ?
         AND entity_id = ?`,
    )
      .bind(fixture.officeId, phoneId)
      .all<{ payload: string }>()
    expect(events).toContainEqual({
      payload: JSON.stringify({ signingKeyStatus: '설정됨' }),
    })
    expect(JSON.stringify(events)).not.toContain(payload.signingKey)
  })

  it.each([
    { label: 'hyphenated', value: '010-5612-9001' },
    { label: 'too short', value: '1234567' },
    { label: 'too long', value: '010123456789' },
    { label: 'letters', value: '0101234ABCD' },
  ])(
    'rejects a $label phone value',
    async ({ value }) => {
      const fixture = await seedFixture()
      const response = await request(
        'POST',
        '/api/office/phones',
        fixture.admin.token,
        {
          value,
          label: '잘못된 업무폰',
          deviceId: `invalid-device-${fixture.suffix}`,
        },
      )

      expect(response.status).toBe(400)
      const count = await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM office_channels WHERE office_id = ?',
      )
        .bind(fixture.officeId)
        .first<{ count: number }>()
      expect(count?.count).toBe(0)
    },
  )

  it('updates a label and preserves a phone through deactivate-reactivate', async () => {
    const fixture = await seedFixture()
    await seedPhone(fixture, {
      id: `default-${fixture.suffix}`,
      value: '18771239',
      label: '대표번호',
      deviceId: null,
      isDefault: true,
    })
    const phoneId = await seedPhone(fixture)

    const labelResponse = await request(
      'PATCH',
      `/api/office/phones/${phoneId}`,
      fixture.admin.token,
      { label: '상담실 업무폰' },
    )
    const deactivate = await request(
      'PATCH',
      `/api/office/phones/${phoneId}/status`,
      fixture.admin.token,
      { active: false },
    )
    const inactiveList = await request(
      'GET',
      '/api/office/phones',
      fixture.admin.token,
    )
    const reactivate = await request(
      'PATCH',
      `/api/office/phones/${phoneId}/status`,
      fixture.admin.token,
      { active: true },
    )

    expect(labelResponse.status).toBe(200)
    expect(deactivate.status).toBe(200)
    const inactivePayload =
      await inactiveList.json<OfficePhonesResponse>()
    expect(inactivePayload.phones).toContainEqual(
      expect.objectContaining({
        id: phoneId,
        label: '상담실 업무폰',
        active: false,
      }),
    )
    expect(reactivate.status).toBe(200)
    await expect(reactivate.json<OfficePhoneResponse>()).resolves
      .toMatchObject({
        phone: {
          id: phoneId,
          label: '상담실 업무폰',
          active: true,
        },
      })
    expect(await storedPhone(phoneId)).toMatchObject({
      label: '상담실 업무폰',
      active: 1,
    })
  })

  it.each([
    { label: 'deputy administrator', role: '부관리자' as const },
    { label: 'tax accountant', role: '세무사' as const },
    { label: 'counselor', role: '상담 담당' as const },
  ])(
    'rejects office-phone management by a $label',
    async ({ role }) => {
      const fixture = await seedFixture()
      const actor = await seedUser(fixture, role, role)
      const phoneId = await seedPhone(fixture)
      const before = await storedPhone(phoneId)

      const list = await request(
        'GET',
        '/api/office/phones',
        actor.token,
      )
      const create = await request(
        'POST',
        '/api/office/phones',
        actor.token,
        {
          value: '01077776666',
          label: '권한 없는 추가',
          deviceId: `blocked-${fixture.suffix}`,
        },
      )
      const update = await request(
        'PATCH',
        `/api/office/phones/${phoneId}`,
        actor.token,
        { label: '권한 없는 수정' },
      )
      const status = await request(
        'PATCH',
        `/api/office/phones/${phoneId}/status`,
        actor.token,
        { active: false },
      )
      const signingKey = await request(
        'POST',
        `/api/office/phones/${phoneId}/signing-key`,
        actor.token,
      )

      expect([
        list.status,
        create.status,
        update.status,
        status.status,
        signingKey.status,
      ]).toEqual([403, 403, 403, 403, 403])
      expect(await storedPhone(phoneId)).toEqual(before)
      const blocked = await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM office_channels WHERE device_id = ?',
      )
        .bind(`blocked-${fixture.suffix}`)
        .first<{ count: number }>()
      expect(blocked?.count).toBe(0)
    },
  )

  it('keeps the single default sender active', async () => {
    const fixture = await seedFixture()
    const defaultId = await seedPhone(fixture, {
      id: `default-${fixture.suffix}`,
      value: '18771239',
      label: '대표번호',
      deviceId: null,
      isDefault: true,
    })
    await seedPhone(fixture)

    const response = await request(
      'PATCH',
      `/api/office/phones/${defaultId}/status`,
      fixture.admin.token,
      { active: false },
    )
    const signingKey = await request(
      'POST',
      `/api/office/phones/${defaultId}/signing-key`,
      fixture.admin.token,
    )

    expect(response.status).toBe(409)
    expect(signingKey.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: '기본 발신번호는 비활성화할 수 없습니다.',
      },
    })
    const defaults = await env.DB.prepare(
      `SELECT COUNT(*) AS count
      FROM office_channels
      WHERE office_id = ?
        AND is_default = 1
        AND active = 1`,
    )
      .bind(fixture.officeId)
      .first<{ count: number }>()
    expect(defaults?.count).toBe(1)
    expect((await storedPhone(defaultId))?.signing_key).toBeNull()
  })
})
