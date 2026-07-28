import type { Role } from '../../shared/domain'
import { error } from './error'

export const SESSION_COOKIE_NAME = 'richchat_session'
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const LAST_SEEN_UPDATE_INTERVAL_MS = 5 * 60 * 1_000

const SESSION_TOKEN_BYTES = 32
const WEBHOOK_PATH_PREFIX = '/api/hooks/'

export interface SessionContext {
  userId: string
  officeId: string
  role: Role
}

export interface IssuedSession {
  id: string
  token: string
  expiresAt: number
}

interface SessionRow {
  user_id: string
  office_id: string
  role: Role
  last_seen_at: number
}

function sessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES))
  const encoded = btoa(String.fromCharCode(...bytes))

  return encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined

  for (const part of header.split(';')) {
    const cookie = part.trim()
    const separator = cookie.indexOf('=')
    if (separator < 0 || cookie.slice(0, separator) !== name) continue

    const value = cookie.slice(separator + 1)
    return value || undefined
  }

  return undefined
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  )

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export function createSessionCookie(
  token: string,
  expiresAt: number,
): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
  ].join('; ')
}

export async function createSession(
  db: D1Database,
  identity: Pick<SessionContext, 'userId' | 'officeId'>,
  now = Date.now(),
): Promise<IssuedSession> {
  const token = sessionToken()
  const id = await hashSessionToken(token)
  const expiresAt = now + SESSION_TTL_MS

  await db
    .prepare(
      `INSERT INTO auth_sessions (
        id, user_id, office_id, created_at, expires_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      identity.userId,
      identity.officeId,
      now,
      expiresAt,
      now,
    )
    .run()

  return { id, token, expiresAt }
}

export function csrfFailure(request: Request): Response | undefined {
  if (request.method === 'GET') return undefined

  const url = new URL(request.url)
  if (url.pathname.startsWith(WEBHOOK_PATH_PREFIX)) return undefined

  if (request.headers.get('origin') !== url.origin) {
    return error('FORBIDDEN', '요청 출처를 확인할 수 없습니다.')
  }

  return undefined
}

export async function resolveSession(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<SessionContext | undefined> {
  const token = cookieValue(request, SESSION_COOKIE_NAME)
  if (!token) return undefined

  const id = await hashSessionToken(token)
  const session = await env.DB.prepare(
    `SELECT
      sessions.user_id,
      sessions.office_id,
      sessions.last_seen_at,
      users.role
    FROM auth_sessions AS sessions
    INNER JOIN users
      ON users.id = sessions.user_id
      AND users.office_id = sessions.office_id
    WHERE sessions.id = ?
      AND sessions.expires_at > ?
      AND users.status = '활성'`,
  )
    .bind(id, now)
    .first<SessionRow>()

  if (!session) return undefined

  if (session.last_seen_at <= now - LAST_SEEN_UPDATE_INTERVAL_MS) {
    await env.DB.prepare(
      `UPDATE auth_sessions
      SET last_seen_at = ?
      WHERE id = ?
        AND last_seen_at <= ?`,
    )
      .bind(now, id, now - LAST_SEEN_UPDATE_INTERVAL_MS)
      .run()
  }

  return {
    userId: session.user_id,
    officeId: session.office_id,
    role: session.role,
  }
}

export async function requireSession(
  request: Request,
  env: Env,
): Promise<SessionContext | Response> {
  const csrfError = csrfFailure(request)
  if (csrfError) return csrfError

  const session = await resolveSession(request, env)
  return session ?? error('UNAUTHORIZED', '로그인이 필요합니다.')
}
