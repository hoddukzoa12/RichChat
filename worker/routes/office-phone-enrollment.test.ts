import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { Role } from '../../shared/domain'
import type {
  OfficePhoneAvailableDevicesResponse,
  OfficePhoneEnrollmentCodeResponse,
  OfficePhoneSigningKeyDeployResponse,
} from '../../shared/wire/office'
import {
  GatewayAdminError,
  type GatewayAdminClient,
} from '../gateway/admin'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import type { Route } from '../http/router'
import { createOfficeRoutes } from './office'

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
  admin: TestUser
  member: TestUser
}

let fixtureSequence = 0

async function seedUser(
  officeId: string,
  suffix: string,
  role: Role,
): Promise<TestUser> {
  const id = `${role}-${suffix}`
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO users (
      id, office_id, email, name, title, role, status, created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '활성', ?, ?)`,
  )
    .bind(
      id,
      officeId,
      `${id}@rich.example`,
      role,
      '상담원',
      role,
      now,
      now,
    )
    .run()
  const session = await createSession(
    env.DB,
    { userId: id, officeId },
    now,
  )
  return { id, token: session.token }
}

async function seedFixture(): Promise<Fixture> {
  fixtureSequence += 1
  const suffix = `enrollment-${fixtureSequence}`
  const officeId = `office-${suffix}`
  await env.DB.prepare(
    'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
  )
    .bind(officeId, '세무법인 리치', Date.now())
    .run()
  const admin = await seedUser(officeId, suffix, '관리자')
  const member = await seedUser(officeId, suffix, '상담 담당')
  return { officeId, admin, member }
}

function gatewayClient(
  overrides: Partial<GatewayAdminClient> = {},
): GatewayAdminClient {
  return {
    issueEnrollmentCode: vi.fn(() =>
      Promise.resolve({
        apiUrl: 'https://sms-gateway.example',
        code: '123456',
        validUntil: '2026-07-30T10:05:00Z',
      }),
    ),
    listDevices: vi.fn(() => Promise.resolve([])),
    deploySigningKey: vi.fn(() => Promise.resolve()),
    ...overrides,
  }
}

async function callRoute(
  routes: readonly Route[],
  method: 'GET' | 'POST',
  path: string,
  token: string,
  routeEnv: Env = env,
): Promise<Response> {
  const route = routes.find(
    (candidate) =>
      candidate.method === method && candidate.path === path,
  )
  if (!route) throw new Error(`${method} ${path} 라우트가 필요합니다.`)

  return route.handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
      },
    }),
    routeEnv,
    {},
  )
}

describe('Office phone enrollment automation', () => {
  it('rejects a non-manager before calling the gateway', async () => {
    const fixture = await seedFixture()
    const gateway = gatewayClient()
    const routes = createOfficeRoutes({ gatewayAdmin: gateway })

    const response = await callRoute(
      routes,
      'POST',
      '/api/office/phones/enrollment-code',
      fixture.member.token,
    )

    expect(response.status).toBe(403)
    expect(gateway.issueEnrollmentCode).not.toHaveBeenCalled()
  })

  it('returns a no-store code without persisting or logging it', async () => {
    const fixture = await seedFixture()
    const gateway = gatewayClient()
    const routes = createOfficeRoutes({
      gatewayAdmin: gateway,
      clock: () => 1_786_000_000_000,
    })

    const response = await callRoute(
      routes,
      'POST',
      '/api/office/phones/enrollment-code',
      fixture.admin.token,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(
      response.json<OfficePhoneEnrollmentCodeResponse>(),
    ).resolves.toEqual({
      enrollment: {
        apiUrl: 'https://sms-gateway.example',
        code: '123456',
        validUntil: '2026-07-30T10:05:00Z',
      },
    })
    const storedCode = await env.DB.prepare(
      `SELECT COUNT(*) AS count
      FROM events
      WHERE office_id = ?
        AND (
          payload LIKE '%123456%'
          OR entity_id LIKE '%123456%'
        )`,
    )
      .bind(fixture.officeId)
      .first<{ count: number }>()
    expect(storedCode?.count).toBe(0)
    const { results } = await env.DB.prepare(
      `SELECT payload
      FROM events
      WHERE office_id = ?
        AND entity = 'office_phone_enrollment'
      ORDER BY office_seq`,
    )
      .bind(fixture.officeId)
      .all<{ payload: string }>()
    expect(results.map(({ payload }) => JSON.parse(payload))).toEqual([
      { result: '요청됨' },
      { result: '성공' },
    ])
  })

  it('limits actual gateway calls to three per five minutes', async () => {
    const fixture = await seedFixture()
    const gateway = gatewayClient()
    let id = 0
    const routes = createOfficeRoutes({
      gatewayAdmin: gateway,
      clock: () => 1_786_000_000_000,
      idFactory: () => `attempt-${fixture.officeId}-${++id}`,
    })

    const responses: Response[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      responses.push(
        await callRoute(
          routes,
          'POST',
          '/api/office/phones/enrollment-code',
          fixture.admin.token,
        ),
      )
    }

    expect(responses.map(({ status }) => status).sort()).toEqual([
      200, 200, 200, 429,
    ])
    expect(gateway.issueEnrollmentCode).toHaveBeenCalledTimes(3)
  })

  it('filters devices already stored in office channels', async () => {
    const fixture = await seedFixture()
    await env.DB.prepare(
      `INSERT INTO office_channels (
        id, office_id, value, label, device_id, is_default, active,
        created_at
      ) VALUES (?, ?, ?, ?, ?, 0, 1, ?)`,
    )
      .bind(
        `phone-${fixture.officeId}`,
        fixture.officeId,
        '01011112222',
        '기존 업무폰',
        'device-registered',
        Date.now(),
      )
      .run()
    const gateway = gatewayClient({
      listDevices: vi.fn(() =>
        Promise.resolve([
          { id: 'device-registered', name: '기존 폰' },
          { id: 'device-new', name: '새 업무폰' },
        ]),
      ),
    })
    const routes = createOfficeRoutes({ gatewayAdmin: gateway })

    const response = await callRoute(
      routes,
      'GET',
      '/api/office/phones/available-devices',
      fixture.admin.token,
    )

    expect(response.status).toBe(200)
    await expect(
      response.json<OfficePhoneAvailableDevicesResponse>(),
    ).resolves.toEqual({
      devices: [{ deviceId: 'device-new', name: '새 업무폰' }],
    })
  })

  it('deploys only the configured shared default key', async () => {
    const fixture = await seedFixture()
    const gateway = gatewayClient()
    const routes = createOfficeRoutes({ gatewayAdmin: gateway })
    const routeEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === 'SMS_GATEWAY_SIGNING_KEYS') {
          return JSON.stringify({
            default: 'shared-key',
            overrides: { 'device-1': 'override-key' },
          })
        }
        return Reflect.get(target, property, receiver)
      },
    }) as Env

    const response = await callRoute(
      routes,
      'POST',
      '/api/office/phones/signing-key',
      fixture.admin.token,
      routeEnv,
    )

    expect(response.status).toBe(200)
    expect(gateway.deploySigningKey).toHaveBeenCalledWith(
      routeEnv,
      'shared-key',
    )
    const body =
      await response.json<OfficePhoneSigningKeyDeployResponse>()
    expect(body.message).toContain('즉시 확인할 수 없습니다')
  })

  it('returns a readable gateway error instead of 500', async () => {
    const fixture = await seedFixture()
    const routes = createOfficeRoutes({
      gatewayAdmin: gatewayClient({
        listDevices: vi.fn(() =>
          Promise.reject(
            new GatewayAdminError(
              'SMS Gateway 계정 인증에 실패했습니다.',
            ),
          ),
        ),
      }),
    })

    const response = await callRoute(
      routes,
      'GET',
      '/api/office/phones/available-devices',
      fixture.admin.token,
    )

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'BAD_GATEWAY',
        message: 'SMS Gateway 계정 인증에 실패했습니다.',
      },
    })
  })
})
