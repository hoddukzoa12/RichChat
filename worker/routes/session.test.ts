import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Role, UserStatus } from '../../shared/domain'
import {
  csrfFailure,
  createSession,
  hashSessionToken,
  LAST_SEEN_UPDATE_INTERVAL_MS,
  resolveSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import { routes as devRoutes } from './dev'
import { USER_EVENT_ENTITY, USER_EVENT_TYPES } from './me'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

interface SeededSession {
  email: string
  officeId: string
  sessionId: string
  token: string
  userId: string
}

interface StoredUser {
  email: string
  name: string
  office_id: string
  role: Role
  status: UserStatus
  title: string
  works_sub: string | null
}

interface StoredSettings {
  notify_new_chat: number
  notify_mine_only: number
  notify_sound: number
}

let seedSequence = 0

async function seedSession(
  status: UserStatus = '활성',
  role: Role = '상담 담당',
): Promise<SeededSession> {
  seedSequence += 1
  const suffix = `session-${seedSequence}`
  const officeId = `office-${suffix}`
  const userId = `user-${suffix}`
  const email = `${suffix}@rich.example`
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      officeId,
      email,
      '박상담',
      '상담 담당',
      role,
      status,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_settings (
        user_id,
        notify_new_chat,
        notify_mine_only,
        notify_sound,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(userId, 1, 0, 1, now),
  ])

  const session = await createSession(env.DB, { userId, officeId }, now)
  return {
    email,
    officeId,
    sessionId: session.id,
    token: session.token,
    userId,
  }
}

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function getMe(token?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/me`, {
    headers: token ? { cookie: cookie(token) } : undefined,
  })
}

async function patch(
  path: string,
  token: string | undefined,
  body: Record<string, unknown>,
  origin = ORIGIN,
): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/json',
    origin,
  })
  if (token) headers.set('cookie', cookie(token))

  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
}

async function storedUser(userId: string): Promise<StoredUser | null> {
  return env.DB.prepare(
    `SELECT
      email, name, office_id, role, status, title, works_sub
    FROM users
    WHERE id = ?`,
  )
    .bind(userId)
    .first<StoredUser>()
}

async function storedSettings(
  userId: string,
): Promise<StoredSettings | null> {
  return env.DB.prepare(
    `SELECT notify_new_chat, notify_mine_only, notify_sound
    FROM user_settings
    WHERE user_id = ?`,
  )
    .bind(userId)
    .first<StoredSettings>()
}

async function settingsRowCount(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
    FROM user_settings
    WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ count: number }>()

  return row?.count ?? 0
}

async function userEventCount(
  userId: string,
  type: (typeof USER_EVENT_TYPES)[keyof typeof USER_EVENT_TYPES],
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
    FROM events
    WHERE entity = ?
      AND entity_id = ?
      AND type = ?`,
  )
    .bind(USER_EVENT_ENTITY, userId, type)
    .first<{ count: number }>()

  return row?.count ?? 0
}

describe('Session authentication', () => {
  it('rejects a request without a session cookie', async () => {
    const response = await getMe()

    expect(response.status).toBe(401)
  })

  it('rejects a well-formed forged session cookie', async () => {
    const response = await getMe('A'.repeat(43))

    expect(response.status).toBe(401)
  })

  it('rejects a cookie whose session row no longer exists', async () => {
    const session = await seedSession()
    await env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?')
      .bind(session.sessionId)
      .run()

    const response = await getMe(session.token)

    expect(response.status).toBe(401)
  })

  it('rejects an expired session', async () => {
    const session = await seedSession()
    await env.DB.prepare(
      'UPDATE auth_sessions SET expires_at = ? WHERE id = ?',
    )
      .bind(Date.now() - 1, session.sessionId)
      .run()

    const response = await getMe(session.token)

    expect(response.status).toBe(401)
  })

  it('rejects an invited user session', async () => {
    const session = await seedSession('초대')

    const response = await getMe(session.token)

    expect(response.status).toBe(401)
  })

  it('rejects an inactive user session', async () => {
    const session = await seedSession('비활성')

    const response = await getMe(session.token)

    expect(response.status).toBe(401)
  })

  it('throttles last-seen writes within the refresh interval', async () => {
    const session = await seedSession()
    const lastSeen = Date.now()
    await env.DB.prepare(
      'UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?',
    )
      .bind(lastSeen, session.sessionId)
      .run()
    const request = new Request(`${ORIGIN}/api/me`, {
      headers: { cookie: cookie(session.token) },
    })

    await resolveSession(
      request,
      env,
      lastSeen + LAST_SEEN_UPDATE_INTERVAL_MS - 1,
    )

    const unchanged = await env.DB.prepare(
      'SELECT last_seen_at FROM auth_sessions WHERE id = ?',
    )
      .bind(session.sessionId)
      .first<{ last_seen_at: number }>()
    expect(unchanged?.last_seen_at).toBe(lastSeen)

    const refreshAt = lastSeen + LAST_SEEN_UPDATE_INTERVAL_MS
    await resolveSession(request, env, refreshAt)

    const refreshed = await env.DB.prepare(
      'SELECT last_seen_at FROM auth_sessions WHERE id = ?',
    )
      .bind(session.sessionId)
      .first<{ last_seen_at: number }>()
    expect(refreshed?.last_seen_at).toBe(refreshAt)
  })
})

describe('Development login', () => {
  it('stores only a SHA-256 session ID and sets secure cookie attributes', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/dev/login`, {
      method: 'POST',
      headers: { origin: ORIGIN },
    })

    expect(response.status).toBe(200)
    const setCookie = response.headers.get('set-cookie')
    expect(setCookie).not.toBeNull()
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')

    const token = setCookie
      ?.split(';', 1)[0]
      .slice(`${SESSION_COOKIE_NAME}=`.length)
    expect(token).toBeTruthy()

    const expectedId = await hashSessionToken(token ?? '')
    const stored = await env.DB.prepare(
      'SELECT id FROM auth_sessions WHERE id = ?',
    )
      .bind(expectedId)
      .first<{ id: string }>()

    expect(stored?.id).toMatch(/^[0-9a-f]{64}$/)
    expect(stored?.id).toBe(expectedId)
    expect(stored?.id).not.toBe(token)

    const devUser = await env.DB.prepare(
      'SELECT role, status FROM users WHERE email = ?',
    )
      .bind('dev@rich.local')
      .first<{ role: Role; status: UserStatus }>()
    const conversationCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM conversations',
    ).first<{ count: number }>()
    const messageCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM messages',
    ).first<{ count: number }>()

    expect(devUser).toEqual({ role: '관리자', status: '활성' })
    expect(conversationCount?.count).toBe(0)
    expect(messageCount?.count).toBe(0)
  })

  it('requires a same-origin request even when explicitly enabled', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/dev/login`, {
      method: 'POST',
    })

    expect(response.status).toBe(403)
  })

  it('does not expose the route when the binding is disabled', async () => {
    const route = devRoutes.find(
      ({ method, path }) =>
        method === 'POST' && path === '/api/dev/login',
    )
    expect(route).toBeDefined()

    const response = await route?.handler(
      new Request(`${ORIGIN}/api/dev/login`, {
        method: 'POST',
        headers: { origin: ORIGIN },
      }),
      { DEV_LOGIN_ENABLED: 'false' } as unknown as Env,
      {},
    )

    expect(response?.status).toBe(404)
  })

  it('does not expose the route when the binding is missing', async () => {
    const route = devRoutes.find(
      ({ method, path }) =>
        method === 'POST' && path === '/api/dev/login',
    )
    expect(route).toBeDefined()

    const response = await route?.handler(
      new Request(`${ORIGIN}/api/dev/login`, {
        method: 'POST',
        headers: { origin: ORIGIN },
      }),
      {} as Env,
      {},
    )

    expect(response?.status).toBe(404)
  })

  it.each([
    { label: 'empty', value: '' },
    { label: 'numeric', value: '1' },
    { label: 'uppercase', value: 'TRUE' },
    { label: 'title-case', value: 'True' },
    { label: 'word', value: 'yes' },
    { label: 'padded', value: ' true ' },
    { label: 'arbitrary', value: 'unexpected' },
  ])(
    'keeps the route closed for the $label enable value',
    async ({ value }) => {
      const route = devRoutes.find(
        ({ method, path }) =>
          method === 'POST' && path === '/api/dev/login',
      )
      expect(route).toBeDefined()

      const response = await route?.handler(
        new Request(`${ORIGIN}/api/dev/login`, {
          method: 'POST',
          headers: { origin: ORIGIN },
        }),
        { DEV_LOGIN_ENABLED: value } as unknown as Env,
        {},
      )

      expect(response?.status).toBe(404)
    },
  )
})

describe('Current user routes', () => {
  it.each([
    {
      path: '/api/me',
      body: { name: '인증 없는 변경' },
    },
    {
      path: '/api/me/settings',
      body: { notifySound: false },
    },
  ])(
    'rejects an unauthenticated PATCH to $path',
    async ({ path, body }) => {
      const response = await patch(path, undefined, body)

      expect(response.status).toBe(401)
    },
  )

  it('derives administrator access from the current database role', async () => {
    const session = await seedSession('활성', '부관리자')
    const before = await getMe(session.token)

    expect(before.status).toBe(200)
    await expect(before.json()).resolves.toMatchObject({
      user: { id: session.userId, role: '부관리자' },
      isAdmin: false,
    })

    await env.DB.prepare(
      'UPDATE users SET role = ?, updated_at = ? WHERE id = ?',
    )
      .bind('관리자', Date.now(), session.userId)
      .run()

    const after = await getMe(session.token)
    expect(after.status).toBe(200)
    await expect(after.json()).resolves.toMatchObject({
      user: { id: session.userId, role: '관리자' },
      isAdmin: true,
    })
  })

  it('updates only editable profile fields', async () => {
    const session = await seedSession('활성', '세무사')
    const updated = await patch('/api/me', session.token, {
      name: '김세무',
      title: '대표 세무사',
    })

    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      user: {
        name: '김세무',
        title: '대표 세무사',
        email: session.email,
        role: '세무사',
      },
    })
    expect(
      await userEventCount(
        session.userId,
        USER_EVENT_TYPES.profileUpdated,
      ),
    ).toBe(1)

    const nameOnly = await patch('/api/me', session.token, {
      name: '이세무',
    })
    expect(nameOnly.status).toBe(200)
    const reflected = await getMe(session.token)
    expect(reflected.status).toBe(200)
    await expect(reflected.json()).resolves.toMatchObject({
      user: {
        name: '이세무',
        title: '대표 세무사',
      },
    })
    expect(
      await userEventCount(
        session.userId,
        USER_EVENT_TYPES.profileUpdated,
      ),
    ).toBe(2)

    const replay = await patch('/api/me', session.token, {
      name: '이세무',
    })
    expect(replay.status).toBe(200)
    expect(
      await userEventCount(
        session.userId,
        USER_EVENT_TYPES.profileUpdated,
      ),
    ).toBe(2)

    const rejected = await patch('/api/me', session.token, {
      email: 'changed@rich.example',
      role: '관리자',
      status: '비활성',
      office_id: 'attacker-office',
      works_sub: 'attacker-sub',
    })
    expect(rejected.status).toBe(400)

    expect(await storedUser(session.userId)).toEqual({
      email: session.email,
      name: '이세무',
      office_id: session.officeId,
      role: '세무사',
      status: '활성',
      title: '대표 세무사',
      works_sub: null,
    })
    expect(
      await userEventCount(
        session.userId,
        USER_EVENT_TYPES.profileUpdated,
      ),
    ).toBe(2)
  })

  it('updates notification settings independently', async () => {
    const session = await seedSession()
    const response = await patch('/api/me/settings', session.token, {
      notifyMineOnly: true,
      notifySound: false,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      settings: {
        notifyNewChat: true,
        notifyMineOnly: true,
        notifySound: false,
      },
    })
    expect(
      await userEventCount(
        session.userId,
        USER_EVENT_TYPES.settingsUpdated,
      ),
    ).toBe(1)
  })

  it('creates missing settings and keeps one row across patches', async () => {
    const session = await seedSession()
    await env.DB.prepare(
      'DELETE FROM user_settings WHERE user_id = ?',
    )
      .bind(session.userId)
      .run()

    const created = await patch(
      '/api/me/settings',
      session.token,
      {
        notifyNewChat: 1,
        notifyMineOnly: 'true',
      },
    )
    expect(created.status).toBe(200)
    expect(await storedSettings(session.userId)).toEqual({
      notify_new_chat: 1,
      notify_mine_only: 1,
      notify_sound: 1,
    })
    expect(await settingsRowCount(session.userId)).toBe(1)
    expect(
      await userEventCount(
        session.userId,
        USER_EVENT_TYPES.settingsUpdated,
      ),
    ).toBe(1)

    const updated = await patch(
      '/api/me/settings',
      session.token,
      { notifySound: 'false' },
    )
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      settings: {
        notifyNewChat: true,
        notifyMineOnly: true,
        notifySound: false,
      },
    })
    expect(await storedSettings(session.userId)).toEqual({
      notify_new_chat: 1,
      notify_mine_only: 1,
      notify_sound: 0,
    })
    expect(await settingsRowCount(session.userId)).toBe(1)
    expect(
      await userEventCount(
        session.userId,
        USER_EVENT_TYPES.settingsUpdated,
      ),
    ).toBe(2)

    const replay = await patch(
      '/api/me/settings',
      session.token,
      { notifySound: 'false' },
    )
    expect(replay.status).toBe(200)
    expect(await settingsRowCount(session.userId)).toBe(1)
    expect(
      await userEventCount(
        session.userId,
        USER_EVENT_TYPES.settingsUpdated,
      ),
    ).toBe(2)

    const invalid = await patch(
      '/api/me/settings',
      session.token,
      { notifySound: 'yes' },
    )
    expect(invalid.status).toBe(400)
    expect(await storedSettings(session.userId)).toEqual({
      notify_new_chat: 1,
      notify_mine_only: 1,
      notify_sound: 0,
    })
    expect(
      await userEventCount(
        session.userId,
        USER_EVENT_TYPES.settingsUpdated,
      ),
    ).toBe(2)
  })

  it('never targets a user ID from the request body', async () => {
    const session = await seedSession()
    const otherUserId = `other-${session.userId}`
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    )
      .bind(
        otherUserId,
        session.officeId,
        `${otherUserId}@rich.example`,
        '다른 사용자',
        '상담 담당',
        now,
        now,
      )
      .run()

    const response = await patch('/api/me', session.token, {
      id: otherUserId,
      name: '공격자가 고른 이름',
    })

    expect(response.status).toBe(400)
    expect((await storedUser(session.userId))?.name).toBe('박상담')
    expect((await storedUser(otherUserId))?.name).toBe('다른 사용자')
    expect(
      await userEventCount(
        session.userId,
        USER_EVENT_TYPES.profileUpdated,
      ),
    ).toBe(0)
  })

  it('does not expose contact or reply signature fields', async () => {
    const session = await seedSession()
    const rejected = await patch('/api/me', session.token, {
      phone: '010-1234-5678',
      signature: '세무법인 리치 박상담 드림',
    })
    expect(rejected.status).toBe(400)

    const response = await getMe(session.token)
    expect(response.status).toBe(200)
    const payload = await response.json<Record<string, unknown>>()
    expect(payload).not.toHaveProperty('phone')
    expect(payload).not.toHaveProperty('signature')
    expect(payload).not.toHaveProperty('user.phone')
    expect(payload).not.toHaveProperty('user.signature')

    const userColumns = await env.DB.prepare(
      "PRAGMA table_info('users')",
    ).all<{ name: string }>()
    const settingsColumns = await env.DB.prepare(
      "PRAGMA table_info('user_settings')",
    ).all<{ name: string }>()
    const columnNames = [
      ...userColumns.results,
      ...settingsColumns.results,
    ].map(({ name }) => name)

    expect(columnNames).not.toContain('phone')
    expect(columnNames).not.toContain('signature')
  })

  it('rejects a cross-origin mutation', async () => {
    const session = await seedSession()
    const response = await patch(
      '/api/me',
      session.token,
      { name: '공격자' },
      'https://attacker.example',
    )

    expect(response.status).toBe(403)
    const stored = await env.DB.prepare(
      'SELECT name FROM users WHERE id = ?',
    )
      .bind(session.userId)
      .first<{ name: string }>()
    expect(stored?.name).toBe('박상담')
  })

  it('exempts external webhook paths from browser-origin checks', () => {
    const failure = csrfFailure(
      new Request(`${ORIGIN}/api/hooks/mo`, {
        method: 'POST',
        headers: { origin: 'https://message-hub.example' },
      }),
    )

    expect(failure).toBeUndefined()
  })
})
