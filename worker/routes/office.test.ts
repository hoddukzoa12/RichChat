import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  ROLES,
  type Role,
  type UserStatus,
} from '../../shared/domain'
import type {
  OfficeInviteResponse,
  OfficeMemberResponse,
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
  name?: string
  role: string
  status: string
  title?: string
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

async function seedUser(
  fixture: Fixture,
  role: Role,
  status: UserStatus = '활성',
  label: string = role,
): Promise<TestUser> {
  const id = `${label}-${fixture.suffix}`
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO users (
      id, office_id, email, name, title, role, status, created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      fixture.officeId,
      `${id}@rich.example`,
      label,
      `${label} 직함`,
      role,
      status,
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

function inviteBody(
  email: string,
  role: Role = '상담 담당',
): {
  email: string
  name: string
  title: string
  role: Role
} {
  return {
    email,
    name: '초대 직원',
    title: '상담원',
    role,
  }
}

async function storedUserById(
  userId: string,
): Promise<StoredUser | null> {
  return env.DB.prepare(
    `SELECT
      email, name, role, status, title, updated_at, works_sub
    FROM users
    WHERE id = ?`,
  )
    .bind(userId)
    .first<StoredUser>()
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
        name: '초대 직원',
        title: '상담원',
        role: '상담 담당',
      },
    },
    {
      method: 'PATCH' as const,
      path: '/api/office/members/member-1',
      body: { name: '변경 이름' },
    },
    {
      method: 'PATCH' as const,
      path: '/api/office/members/member-1/status',
      body: { status: '비활성' },
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
        inviteBody(email),
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
        name: '  김초대  ',
        title: '  선임 세무사  ',
        role: '세무사',
      },
    )

    expect(response.status).toBe(201)
    const payload = await response.json<OfficeInviteResponse>()
    expect(payload.member).toMatchObject({
      email,
      name: '김초대',
      title: '선임 세무사',
      role: '세무사',
      status: '초대',
    })
    const stored = await env.DB.prepare(
      `SELECT
        email, name, role, status, title, updated_at, works_sub
      FROM users
      WHERE email = ?`,
    )
      .bind(email)
      .first<StoredUser>()
    expect(stored).toMatchObject({
      email,
      name: '김초대',
      role: '세무사',
      status: '초대',
      title: '선임 세무사',
      works_sub: null,
    })
    expect(
      await eventCount(
        fixture.officeId,
        'office.member.invited',
      ),
    ).toBe(1)
  })

  it('uses the email local part when an invite name is blank', async () => {
    const fixture = await seedFixture()
    const email = `fallback-${fixture.suffix}@rich.example`

    const response = await request(
      'POST',
      '/api/office/invites',
      fixture.admin.token,
      {
        ...inviteBody(email),
        name: ' \n ',
      },
    )

    expect(response.status).toBe(201)
    await expect(response.json<OfficeInviteResponse>()).resolves
      .toMatchObject({
        member: {
          email,
          name: `fallback-${fixture.suffix}`,
          title: '상담원',
        },
      })
  })

  it('creates one user and one event for repeated invitations', async () => {
    const fixture = await seedFixture()
    const email = `duplicate-${fixture.suffix}@rich.example`

    const first = await request(
      'POST',
      '/api/office/invites',
      fixture.admin.token,
      inviteBody(email),
    )
    const second = await request(
      'POST',
      '/api/office/invites',
      fixture.admin.token,
      {
        ...inviteBody(` ${email.toUpperCase()} `, '세무사'),
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
      inviteBody(email),
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
        ...inviteBody(
          `blocked-${fixture.suffix}@rich.example`,
        ),
      },
    )

    expect(response.status).toBe(403)
    expect(await officeUserCount(fixture.officeId)).toBe(2)
    expect(await eventCount(fixture.officeId)).toBe(0)
  })

  it('allows an administrator invitation by an administrator', async () => {
    const fixture = await seedFixture()

    const response = await request(
      'POST',
      '/api/office/invites',
      fixture.admin.token,
      {
        ...inviteBody(
          `new-admin-${fixture.suffix}@rich.example`,
          '관리자',
        ),
      },
    )

    expect(response.status).toBe(201)
    await expect(response.json<OfficeInviteResponse>()).resolves
      .toMatchObject({
        member: { role: '관리자', status: '초대' },
      })
    expect(await officeUserCount(fixture.officeId)).toBe(3)
  })

  it('allows invitations for every role', async () => {
    const fixture = await seedFixture()

    for (const role of ROLES) {
      const response = await request(
        'POST',
        '/api/office/invites',
        fixture.admin.token,
        inviteBody(
          `${ROLES.indexOf(role)}-${fixture.suffix}@rich.example`,
          role,
        ),
      )
      expect(response.status).toBe(201)
      await expect(response.json<OfficeInviteResponse>()).resolves
        .toMatchObject({
          member: { role, status: '초대' },
        })
    }
  })

  it('allows a deputy administrator to invite a non-administrator', async () => {
    const fixture = await seedFixture()
    const deputy = await seedUser(fixture, '부관리자')
    const email = `deputy-invite-${fixture.suffix}@rich.example`

    const response = await request(
      'POST',
      '/api/office/invites',
      deputy.token,
      {
        email,
        name: '박세무',
        title: '선임 세무사',
        role: '세무사',
      },
    )

    expect(response.status).toBe(201)
    const payload = await response.json<OfficeInviteResponse>()
    expect(payload.member).toEqual({
      id: expect.any(String),
      email,
      name: '박세무',
      title: '선임 세무사',
      role: '세무사',
      status: '초대',
    })
  })

  it('rejects an administrator invitation by a deputy administrator', async () => {
    const fixture = await seedFixture()
    const deputy = await seedUser(fixture, '부관리자')

    const response = await request(
      'POST',
      '/api/office/invites',
      deputy.token,
      inviteBody(
        `blocked-admin-${fixture.suffix}@rich.example`,
        '관리자',
      ),
    )

    expect(response.status).toBe(403)
    expect(await officeUserCount(fixture.officeId)).toBe(3)
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

  it('gives a deputy administrator every member status', async () => {
    const fixture = await seedFixture()
    const deputy = await seedUser(fixture, '부관리자')
    const invited = await seedUser(
      fixture,
      '상담 담당',
      '초대',
      '초대 대기',
    )
    const inactive = await seedUser(
      fixture,
      '세무사',
      '비활성',
      '퇴사 직원',
    )

    const response = await request(
      'GET',
      '/api/office/members',
      deputy.token,
    )

    expect(response.status).toBe(200)
    const payload = await response.json<OfficeMembersResponse>()
    expect(payload.members).toContainEqual(
      expect.objectContaining({
        id: invited.id,
        status: '초대',
      }),
    )
    expect(payload.members).toContainEqual(
      expect.objectContaining({
        id: inactive.id,
        status: '비활성',
      }),
    )
    expect(
      payload.members.every((member) =>
        Object.hasOwn(member, 'status'),
      ),
    ).toBe(true)
  })

  it('updates a member name, title, and role', async () => {
    const fixture = await seedFixture()

    const response = await request(
      'PATCH',
      `/api/office/members/${fixture.member.id}`,
      fixture.admin.token,
      {
        name: '김세무',
        title: '선임 세무사',
        role: '세무사',
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json<OfficeMemberResponse>()).resolves
      .toEqual({
        member: {
          id: fixture.member.id,
          email: `${fixture.member.id}@rich.example`,
          name: '김세무',
          title: '선임 세무사',
          role: '세무사',
          status: '활성',
        },
      })
    expect(await storedUserById(fixture.member.id)).toMatchObject({
      name: '김세무',
      title: '선임 세무사',
      role: '세무사',
      status: '활성',
    })
    expect(
      await eventCount(
        fixture.officeId,
        'office.member.updated',
      ),
    ).toBe(1)
  })

  it('keeps an administrator unchanged when a deputy administrator edits or deactivates them', async () => {
    const fixture = await seedFixture()
    const deputy = await seedUser(fixture, '부관리자')
    const before = await storedUserById(fixture.admin.id)

    const edit = await request(
      'PATCH',
      `/api/office/members/${fixture.admin.id}`,
      deputy.token,
      { name: '권한 없는 변경' },
    )
    const deactivate = await request(
      'PATCH',
      `/api/office/members/${fixture.admin.id}/status`,
      deputy.token,
      { status: '비활성' },
    )

    expect(edit.status).toBe(403)
    expect(deactivate.status).toBe(403)
    expect(await storedUserById(fixture.admin.id)).toEqual(before)
    expect(await eventCount(fixture.officeId)).toBe(0)
  })

  it('keeps a member unchanged when a deputy administrator assigns the administrator role', async () => {
    const fixture = await seedFixture()
    const deputy = await seedUser(fixture, '부관리자')
    const before = await storedUserById(fixture.member.id)

    const response = await request(
      'PATCH',
      `/api/office/members/${fixture.member.id}`,
      deputy.token,
      { role: '관리자' },
    )

    expect(response.status).toBe(403)
    expect(await storedUserById(fixture.member.id)).toEqual(before)
    expect(await eventCount(fixture.officeId)).toBe(0)
  })

  it.each([
    { label: 'counselor', role: '상담 담당' as const },
    { label: 'tax accountant', role: '세무사' as const },
  ])(
    'rejects member management by a $label',
    async ({ role }) => {
      const fixture = await seedFixture()
      const actor =
        role === '상담 담당'
          ? fixture.member
          : await seedUser(fixture, role)
      const before = await storedUserById(fixture.member.id)

      const invite = await request(
        'POST',
        '/api/office/invites',
        actor.token,
        inviteBody(
          `forbidden-${role}-${fixture.suffix}@rich.example`,
        ),
      )
      const update = await request(
        'PATCH',
        `/api/office/members/${fixture.member.id}`,
        actor.token,
        { name: '권한 없는 이름' },
      )

      expect(invite.status).toBe(403)
      expect(update.status).toBe(403)
      expect(await storedUserById(fixture.member.id)).toEqual(before)
    },
  )

  it('keeps the last active administrator from being demoted or deactivated', async () => {
    const fixture = await seedFixture()

    const demote = await request(
      'PATCH',
      `/api/office/members/${fixture.admin.id}`,
      fixture.admin.token,
      { role: '부관리자' },
    )
    const deactivate = await request(
      'PATCH',
      `/api/office/members/${fixture.admin.id}/status`,
      fixture.admin.token,
      { status: '비활성' },
    )

    expect(demote.status).toBe(409)
    expect(deactivate.status).toBe(409)
    expect(await storedUserById(fixture.admin.id)).toMatchObject({
      role: '관리자',
      status: '활성',
    })
    expect(await eventCount(fixture.officeId)).toBe(0)
  })

  it('serializes concurrent administrator demotions without losing the last administrator', async () => {
    const fixture = await seedFixture()
    const secondAdmin = await seedUser(
      fixture,
      '관리자',
      '활성',
      '동시 변경 관리자',
    )

    const responses = await Promise.all([
      request(
        'PATCH',
        `/api/office/members/${fixture.admin.id}`,
        fixture.admin.token,
        { role: '부관리자' },
      ),
      request(
        'PATCH',
        `/api/office/members/${secondAdmin.id}`,
        secondAdmin.token,
        { role: '부관리자' },
      ),
    ])

    expect(responses.map(({ status }) => status).sort()).toEqual([
      200,
      409,
    ])
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS count
      FROM users
      WHERE office_id = ?
        AND role = '관리자'
        AND status = '활성'`,
    )
      .bind(fixture.officeId)
      .first<{ count: number }>()
    expect(remaining?.count).toBe(1)
  })

  it('rejects self-deactivation even when another administrator exists', async () => {
    const fixture = await seedFixture()
    const deputy = await seedUser(fixture, '부관리자')
    await seedUser(fixture, '관리자', '활성', '두 번째 관리자')

    const response = await request(
      'PATCH',
      `/api/office/members/${deputy.id}/status`,
      deputy.token,
      { status: '비활성' },
    )

    expect(response.status).toBe(409)
    expect(await storedUserById(deputy.id)).toMatchObject({
      status: '활성',
    })
  })

  it('deactivates without deleting authored history and rejects the old session', async () => {
    const fixture = await seedFixture()
    const customerId = `customer-${fixture.suffix}`
    const conversationId = `conversation-${fixture.suffix}`
    const messageId = `message-${fixture.suffix}`
    const noteId = `note-${fixture.suffix}`
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO customers (
          id, office_id, phone_e164, name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        customerId,
        fixture.officeId,
        `+8210${String(fixtureSequence).padStart(8, '0')}`,
        '이력 고객',
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO conversations (
          id, office_id, customer_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, '미처리', ?, ?)`,
      ).bind(
        conversationId,
        fixture.officeId,
        customerId,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO messages (
          id, office_id, conversation_id, direction, channel, body,
          sender_user_id, occurred_at, created_at, client_key,
          delivery_status
        ) VALUES (?, ?, ?, 'out', 'SMS', ?, ?, ?, ?, ?, '대기')`,
      ).bind(
        messageId,
        fixture.officeId,
        conversationId,
        '작성 메시지',
        fixture.member.id,
        now,
        now,
        `client-${fixture.suffix}`,
      ),
      env.DB.prepare(
        `INSERT INTO notes (
          id, office_id, conversation_id, author_id, body, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        noteId,
        fixture.officeId,
        conversationId,
        fixture.member.id,
        '작성 메모',
        now,
        now,
      ),
    ])

    const response = await request(
      'PATCH',
      `/api/office/members/${fixture.member.id}/status`,
      fixture.admin.token,
      { status: '비활성' },
    )

    expect(response.status).toBe(200)
    expect(await storedUserById(fixture.member.id)).toMatchObject({
      status: '비활성',
    })
    const history = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM messages WHERE id = ?) AS messages,
        (SELECT COUNT(*) FROM notes WHERE id = ?) AS notes`,
    )
      .bind(messageId, noteId)
      .first<{ messages: number; notes: number }>()
    expect(history).toEqual({ messages: 1, notes: 1 })
    expect(
      (
        await request(
          'GET',
          '/api/me',
          fixture.member.token,
        )
      ).status,
    ).toBe(401)
  })

  it('reactivates a member and restores their existing session', async () => {
    const fixture = await seedFixture()
    const deactivate = await request(
      'PATCH',
      `/api/office/members/${fixture.member.id}/status`,
      fixture.admin.token,
      { status: '비활성' },
    )
    const reactivate = await request(
      'PATCH',
      `/api/office/members/${fixture.member.id}/status`,
      fixture.admin.token,
      { status: '활성' },
    )

    expect(deactivate.status).toBe(200)
    expect(reactivate.status).toBe(200)
    await expect(reactivate.json<OfficeMemberResponse>()).resolves
      .toMatchObject({
        member: {
          id: fixture.member.id,
          status: '활성',
        },
      })
    expect(
      (
        await request(
          'GET',
          '/api/me',
          fixture.member.token,
        )
      ).status,
    ).toBe(200)
  })
})
