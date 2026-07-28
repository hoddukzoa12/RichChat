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

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

interface SeededSession {
  email: string
  sessionId: string
  token: string
  userId: string
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
  token: string,
  body: Record<string, unknown>,
  origin = ORIGIN,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'PATCH',
    headers: {
      cookie: cookie(token),
      'content-type': 'application/json',
      origin,
    },
    body: JSON.stringify(body),
  })
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
  it('derives administrator access from the current database role', async () => {
    const session = await seedSession('활성', '상담 담당')
    const before = await getMe(session.token)

    expect(before.status).toBe(200)
    await expect(before.json()).resolves.toMatchObject({
      user: { id: session.userId, role: '상담 담당' },
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

    const rejected = await patch('/api/me', session.token, {
      email: 'changed@rich.example',
      role: '관리자',
    })
    expect(rejected.status).toBe(400)

    const stored = await env.DB.prepare(
      'SELECT email, role FROM users WHERE id = ?',
    )
      .bind(session.userId)
      .first<{ email: string; role: Role }>()
    expect(stored).toEqual({
      email: session.email,
      role: '세무사',
    })
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
