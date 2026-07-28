import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type {
  OfficeInviteResponse,
  OfficeMembersResponse,
  OfficeSettingsResponse,
} from '../../shared/wire/office'
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
  admin: TestUser
  member: TestUser
  officeId: string
  suffix: string
}

interface StoredSettings {
  export_log: number
  retention_years: number
  updated_at: number
  updated_by: string | null
}

interface StoredUser {
  email: string
  role: string
  status: string
  updated_at: number
  works_sub: string | null
}

let fixtureSequence = 0

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function seedFixture(): Promise<Fixture> {
  fixtureSequence += 1
  const suffix = `office-${fixtureSequence}`
  const officeId = `office-${suffix}`
  const adminId = `admin-${suffix}`
  const memberId = `member-${suffix}`
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, '관리자', '활성', ?, ?)`,
    ).bind(
      adminId,
      officeId,
      `${adminId}@rich.example`,
      '관리자',
      '팀장',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    ).bind(
      memberId,
      officeId,
      `${memberId}@rich.example`,
      '상담원',
      '상담 담당',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO office_settings (
        office_id, export_log, retention_years, updated_at, updated_by
      ) VALUES (?, 0, 5, ?, NULL)`,
    ).bind(officeId, now),
  ])

  const [adminSession, memberSession] = await Promise.all([
    createSession(env.DB, { userId: adminId, officeId }, now),
    createSession(env.DB, { userId: memberId, officeId }, now),
  ])

  return {
    admin: { id: adminId, token: adminSession.token },
    member: { id: memberId, token: memberSession.token },
    officeId,
    suffix,
  }
}

async function request(
  method: 'GET' | 'PATCH' | 'POST',
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

async function storedSettings(
  officeId: string,
): Promise<StoredSettings | null> {
  return env.DB.prepare(
    `SELECT
      export_log, retention_years, updated_at, updated_by
    FROM office_settings
    WHERE office_id = ?`,
  )
    .bind(officeId)
    .first<StoredSettings>()
}

async function eventCount(
  officeId: string,
  type?: string,
): Promise<number> {
  const row = type
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS count
        FROM events
        WHERE office_id = ?
          AND type = ?`,
      )
        .bind(officeId, type)
        .first<{ count: number }>()
    : await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM events WHERE office_id = ?',
      )
        .bind(officeId)
        .first<{ count: number }>()

  return row?.count ?? 0
}

async function officeUserCount(officeId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM users WHERE office_id = ?',
  )
    .bind(officeId)
    .first<{ count: number }>()

  return row?.count ?? 0
}

describe('Office administration', () => {
  it.each([
    {
      method: 'GET' as const,
      path: '/api/office/settings',
      body: undefined,
    },
    {
      method: 'PATCH' as const,
      path: '/api/office/settings',
      body: { retentionYears: 7 },
    },
    {
      method: 'GET' as const,
      path: '/api/office/members',
      body: undefined,
    },
    {
      method: 'POST' as const,
      path: '/api/office/invites',
      body: {
        email: 'invitee@rich.example',
        role: '상담 담당',
      },
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

  it('allows only an administrator to read office settings', async () => {
    const fixture = await seedFixture()

    const memberResponse = await request(
      'GET',
      '/api/office/settings',
      fixture.member.token,
    )
    expect(memberResponse.status).toBe(403)

    const adminResponse = await request(
      'GET',
      '/api/office/settings',
      fixture.admin.token,
    )
    expect(adminResponse.status).toBe(200)
    expect(
      await adminResponse.json<OfficeSettingsResponse>(),
    ).toEqual({
      settings: {
        exportLog: false,
        retentionYears: 5,
        updatedAt: expect.any(Number),
        updatedBy: null,
      },
    })
  })

  it('keeps settings unchanged when a non-administrator patches them', async () => {
    const fixture = await seedFixture()
    const before = await storedSettings(fixture.officeId)

    const response = await request(
      'PATCH',
      '/api/office/settings',
      fixture.member.token,
      { exportLog: true, retentionYears: 9 },
    )

    expect(response.status).toBe(403)
    expect(await storedSettings(fixture.officeId)).toEqual(before)
    expect(await eventCount(fixture.officeId)).toBe(0)
  })

  it('updates settings with the session administrator as actor', async () => {
    const fixture = await seedFixture()

    const response = await request(
      'PATCH',
      '/api/office/settings',
      fixture.admin.token,
      { exportLog: true, retentionYears: 7 },
    )

    expect(response.status).toBe(200)
    const payload = await response.json<OfficeSettingsResponse>()
    expect(payload.settings).toMatchObject({
      exportLog: true,
      retentionYears: 7,
      updatedBy: fixture.admin.id,
    })
    expect(await storedSettings(fixture.officeId)).toMatchObject({
      export_log: 1,
      retention_years: 7,
      updated_by: fixture.admin.id,
    })
    expect(
      await eventCount(
        fixture.officeId,
        'office.settings.updated',
      ),
    ).toBe(1)
  })

  it('does not publish another event for an idempotent settings patch', async () => {
    const fixture = await seedFixture()
    const patch = { exportLog: true, retentionYears: 7 }

    const first = await request(
      'PATCH',
      '/api/office/settings',
      fixture.admin.token,
      patch,
    )
    const second = await request(
      'PATCH',
      '/api/office/settings',
      fixture.admin.token,
      patch,
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(
      await eventCount(
        fixture.officeId,
        'office.settings.updated',
      ),
    ).toBe(1)
  })

  it.each([0, -1, 101, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects an invalid retention period: %s',
    async (retentionYears) => {
      const fixture = await seedFixture()
      const before = await storedSettings(fixture.officeId)

      const response = await request(
        'PATCH',
        '/api/office/settings',
        fixture.admin.token,
        { retentionYears },
      )

      expect(response.status).toBe(400)
      expect(await storedSettings(fixture.officeId)).toEqual(before)
      expect(await eventCount(fixture.officeId)).toBe(0)
    },
  )

  it.each([
    { label: 'leading at sign', email: '@x.com' },
    { label: 'empty', email: '' },
    { label: 'missing domain', email: 'a@' },
    { label: 'multiple at signs', email: 'a@@b.com' },
    { label: 'whitespace only', email: ' \n\t ' },
    {
      label: 'overlong',
      email: `${'a'.repeat(5_000)}@rich.example`,
    },
  ])(
    'rejects a malformed invite email: $label',
    async ({ email }) => {
      const fixture = await seedFixture()

      const response = await request(
        'POST',
        '/api/office/invites',
        fixture.admin.token,
        { email, role: '상담 담당' },
      )

      expect(response.status).toBe(400)
      expect(await officeUserCount(fixture.officeId)).toBe(2)
      expect(await eventCount(fixture.officeId)).toBe(0)
    },
  )

  it('normalizes an email before storing an invitation', async () => {
    const fixture = await seedFixture()
    const email = `invitee-${fixture.suffix}@rich.example`

    const response = await request(
      'POST',
      '/api/office/invites',
      fixture.admin.token,
      {
        email: `  INVITEE-${fixture.suffix}@RICH.EXAMPLE  `,
        role: '세무사',
      },
    )

    expect(response.status).toBe(201)
    const payload = await response.json<OfficeInviteResponse>()
    expect(payload.member).toMatchObject({
      email,
      name: email,
      title: '세무사',
      role: '세무사',
      status: '초대',
    })
    const stored = await env.DB.prepare(
      `SELECT email, role, status, updated_at, works_sub
      FROM users
      WHERE email = ?`,
    )
      .bind(email)
      .first<StoredUser>()
    expect(stored).toMatchObject({
      email,
      role: '세무사',
      status: '초대',
      works_sub: null,
    })
    expect(
      await eventCount(
        fixture.officeId,
        'office.member.invited',
      ),
    ).toBe(1)
  })

  it('creates one user and one event for repeated invitations', async () => {
    const fixture = await seedFixture()
    const email = `duplicate-${fixture.suffix}@rich.example`

    const first = await request(
      'POST',
      '/api/office/invites',
      fixture.admin.token,
      { email, role: '상담 담당' },
    )
    const second = await request(
      'POST',
      '/api/office/invites',
      fixture.admin.token,
      {
        email: ` ${email.toUpperCase()} `,
        role: '세무사',
      },
    )

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM users WHERE email = ?',
    )
      .bind(email)
      .first<{ count: number }>()
    expect(count?.count).toBe(1)
    expect(
      await eventCount(
        fixture.officeId,
        'office.member.invited',
      ),
    ).toBe(1)
  })

  it('does not demote an active user when invited again', async () => {
    const fixture = await seedFixture()
    const email = `active-${fixture.suffix}@rich.example`
    const activeUserId = `active-${fixture.suffix}`
    const updatedAt = Date.now() - 1_000
    await env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, works_sub, name, title, role, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '세무사', '활성', ?, ?)`,
    )
      .bind(
        activeUserId,
        fixture.officeId,
        email,
        `works-${fixture.suffix}`,
        '활성 직원',
        '세무사',
        updatedAt,
        updatedAt,
      )
      .run()

    const response = await request(
      'POST',
      '/api/office/invites',
      fixture.admin.token,
      { email, role: '상담 담당' },
    )

    expect(response.status).toBe(200)
    const stored = await env.DB.prepare(
      `SELECT email, role, status, updated_at, works_sub
      FROM users
      WHERE id = ?`,
    )
      .bind(activeUserId)
      .first<StoredUser>()
    expect(stored).toEqual({
      email,
      role: '세무사',
      status: '활성',
      updated_at: updatedAt,
      works_sub: `works-${fixture.suffix}`,
    })
    expect(await eventCount(fixture.officeId)).toBe(0)
  })

  it('enforces invite authorization in the insert statement', async () => {
    const fixture = await seedFixture()

    const response = await request(
      'POST',
      '/api/office/invites',
      fixture.member.token,
      {
        email: `blocked-${fixture.suffix}@rich.example`,
        role: '상담 담당',
      },
    )

    expect(response.status).toBe(403)
    expect(await officeUserCount(fixture.officeId)).toBe(2)
    expect(await eventCount(fixture.officeId)).toBe(0)
  })

  it('does not allow an invitation to grant administrator role', async () => {
    const fixture = await seedFixture()

    const response = await request(
      'POST',
      '/api/office/invites',
      fixture.admin.token,
      {
        email: `admin-${fixture.suffix}@rich.example`,
        role: '관리자',
      },
    )

    expect(response.status).toBe(400)
    expect(await officeUserCount(fixture.officeId)).toBe(2)
  })

  it('allows a non-administrator to list only active public members', async () => {
    const fixture = await seedFixture()
    const invitedId = `invited-${fixture.suffix}`
    await env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, '상담 담당', '초대', ?, ?)`,
    )
      .bind(
        invitedId,
        fixture.officeId,
        `${invitedId}@rich.example`,
        '초대 직원',
        '상담 담당',
        Date.now(),
        Date.now(),
      )
      .run()

    const memberResponse = await request(
      'GET',
      '/api/office/members',
      fixture.member.token,
    )

    expect(memberResponse.status).toBe(200)
    const memberText = await memberResponse.text()
    expect(memberText).not.toContain('works_sub')
    expect(memberText).not.toContain('session')
    const memberPayload = JSON.parse(
      memberText,
    ) as OfficeMembersResponse
    expect(memberPayload.members).toHaveLength(2)
    expect(
      memberPayload.members.every(
        (member) => !Object.hasOwn(member, 'status'),
      ),
    ).toBe(true)

    const adminResponse = await request(
      'GET',
      '/api/office/members',
      fixture.admin.token,
    )
    expect(adminResponse.status).toBe(200)
    const adminPayload =
      await adminResponse.json<OfficeMembersResponse>()
    expect(adminPayload.members).toContainEqual(
      expect.objectContaining({
        id: invitedId,
        status: '초대',
      }),
    )
  })
})
