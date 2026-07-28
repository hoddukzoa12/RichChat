import { canonicalizeEmail } from '../../shared/email'
import { executeBatch } from '../db/d1'
import { error } from '../http/error'
import type { Route } from '../http/router'
import {
  createSession,
  createSessionCookie,
  csrfFailure,
  hashSessionToken,
  SESSION_COOKIE_NAME,
} from '../http/session'
import type { Clock } from '../lib/ids'
import {
  exchangeAuthorizationCode,
  getWorksConfiguration,
  type OidcFetch,
  verifyIdToken,
  type WorksOidcBindings,
} from '../works/oidc'

const CALLBACK_PATH = '/api/auth/callback'
const DEFAULT_REDIRECT = '/'
export const OAUTH_STATE_COOKIE_NAME = 'richchat_oauth_state'
const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000
const RANDOM_VALUE_BYTES = 32

const DEFAULT_CLOCK: Clock = Date.now
const DEFAULT_FETCH: OidcFetch = (input, init) => fetch(input, init)

interface AuthDependencies {
  clock?: Clock
  fetcher?: OidcFetch
}

interface OauthStateRow {
  nonce: string
  code_verifier: string
  redirect_to: string
  expires_at: number
}

interface UserRow {
  id: string
  office_id: string
}

interface UserCandidateRow extends UserRow {
  email: string
}

function randomBase64Url(): string {
  const bytes = crypto.getRandomValues(
    new Uint8Array(RANDOM_VALUE_BYTES),
  )
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return btoa(
    String.fromCharCode(...new Uint8Array(digest)),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function callbackUri(request: Request): string {
  return new URL(CALLBACK_PATH, request.url).toString()
}

function safeRedirectTo(
  value: string | null,
  requestOrigin: string,
): string {
  if (
    value === null ||
    !value.startsWith('/') ||
    value.startsWith('//')
  ) {
    return DEFAULT_REDIRECT
  }

  try {
    const resolved = new URL(value, requestOrigin)
    if (resolved.origin !== requestOrigin) return DEFAULT_REDIRECT
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return DEFAULT_REDIRECT
  }
}

function htmlFailure(status: number): Response {
  return new Response(
    `<!doctype html>
<html lang="ko">
  <head><meta charset="utf-8"><title>로그인 실패</title></head>
  <body>
    <main>
      <h1>로그인할 수 없습니다.</h1>
      <p>잠시 후 다시 시도하거나 관리자에게 문의해 주세요.</p>
      <a href="/api/auth/login">다시 로그인</a>
    </main>
  </body>
</html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  )
}

function oauthStateCookie(
  value: string,
  expiresAt: number,
): string {
  return [
    `${OAUTH_STATE_COOKIE_NAME}=${value}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Path=${CALLBACK_PATH}`,
  ].join('; ')
}

function callbackFailure(status: number): Response {
  const response = htmlFailure(status)
  response.headers.set('set-cookie', oauthStateCookie('', 0))
  return response
}

function redirect(location: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('location', location)
  responseHeaders.set('cache-control', 'no-store')
  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  })
}

function worksBindings(env: Env): WorksOidcBindings {
  return {
    WORKS_CLIENT_ID: env.WORKS_CLIENT_ID,
    WORKS_CLIENT_SECRET: env.WORKS_CLIENT_SECRET,
    WORKS_ISSUER: env.WORKS_ISSUER,
    WORKS_TENANT_ID: env.WORKS_TENANT_ID,
  }
}

function hasWorksBindings(env: Env): boolean {
  return [
    env.WORKS_CLIENT_ID,
    env.WORKS_CLIENT_SECRET,
    env.WORKS_ISSUER,
    env.WORKS_TENANT_ID,
  ].every((value) => typeof value === 'string' && value !== '')
}

async function startLogin(
  request: Request,
  env: Env,
  clock: Clock,
  fetcher: OidcFetch,
): Promise<Response> {
  if (!hasWorksBindings(env)) {
    return error('NOT_FOUND', '요청한 API를 찾을 수 없습니다.')
  }

  const now = clock()
  const bindings = worksBindings(env)

  let configuration
  try {
    configuration = await getWorksConfiguration(
      bindings,
      fetcher,
      now,
    )
  } catch {
    return htmlFailure(500)
  }

  const requestUrl = new URL(request.url)
  const state = randomBase64Url()
  const nonce = randomBase64Url()
  const codeVerifier = randomBase64Url()
  const browserSecret = randomBase64Url()
  const browserSecretHash = await hashSessionToken(browserSecret)
  const redirectTo = safeRedirectTo(
    requestUrl.searchParams.get('redirect_to'),
    requestUrl.origin,
  )
  const expiresAt = now + OAUTH_STATE_TTL_MS

  try {
    await executeBatch(env.DB, [
      env.DB.prepare(
        'DELETE FROM oauth_states WHERE expires_at <= ?',
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO oauth_states (
          state, nonce, code_verifier, browser_secret_hash, redirect_to,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        state,
        nonce,
        codeVerifier,
        browserSecretHash,
        redirectTo,
        expiresAt,
      ),
    ])
  } catch {
    return htmlFailure(500)
  }

  const authorizationUrl = new URL(
    configuration.authorizationEndpoint,
  )
  authorizationUrl.search = new URLSearchParams({
    client_id: bindings.WORKS_CLIENT_ID,
    redirect_uri: callbackUri(request),
    response_type: 'code',
    scope: 'openid email',
    state,
    nonce,
    code_challenge: await pkceChallenge(codeVerifier),
    code_challenge_method: 'S256',
  }).toString()

  return redirect(authorizationUrl.toString(), {
    'set-cookie': oauthStateCookie(browserSecret, expiresAt),
  })
}

async function consumeState(
  db: D1Database,
  state: string,
  browserSecretHash: string,
): Promise<OauthStateRow | null> {
  return db.prepare(
    `DELETE FROM oauth_states
    WHERE state = ?
      AND browser_secret_hash = ?
    RETURNING nonce, code_verifier, redirect_to, expires_at`,
  )
    .bind(state, browserSecretHash)
    .first<OauthStateRow>()
}

async function claimUser(
  db: D1Database,
  email: string,
  subject: string,
  now: number,
): Promise<UserRow | null> {
  const canonicalEmail = canonicalizeEmail(email)
  if (canonicalEmail === '') return null

  const { results } = await db.prepare(
    `SELECT id, office_id, email
    FROM users
    WHERE status IN ('초대', '활성')`,
  ).all<UserCandidateRow>()
  const candidates = results.filter(
    (candidate) =>
      canonicalizeEmail(candidate.email) === canonicalEmail,
  )
  if (candidates.length !== 1) return null
  const [candidate] = candidates

  const activated = await db.prepare(
    `UPDATE users
    SET works_sub = ?, status = '활성', updated_at = ?
    WHERE id = ?
      AND email = ?
      AND status = '초대'
      AND (works_sub IS NULL OR works_sub = ?)
    RETURNING id, office_id`,
  )
    .bind(
      subject,
      now,
      candidate.id,
      candidate.email,
      subject,
    )
    .first<UserRow>()
  if (activated) return activated

  return db.prepare(
    `SELECT id, office_id
    FROM users
    WHERE id = ?
      AND email = ?
      AND status = '활성'
      AND works_sub = ?
    LIMIT 1`,
  )
    .bind(candidate.id, candidate.email, subject)
    .first<UserRow>()
}

async function finishLogin(
  request: Request,
  env: Env,
  clock: Clock,
  fetcher: OidcFetch,
): Promise<Response> {
  const requestUrl = new URL(request.url)
  const state = requestUrl.searchParams.get('state')
  const browserSecret = cookieValue(
    request,
    OAUTH_STATE_COOKIE_NAME,
  )
  if (!state || !browserSecret) return callbackFailure(400)

  let oauthState: OauthStateRow | null
  try {
    oauthState = await consumeState(
      env.DB,
      state,
      await hashSessionToken(browserSecret),
    )
  } catch {
    return callbackFailure(500)
  }

  const now = clock()
  if (!oauthState || oauthState.expires_at <= now) {
    return callbackFailure(400)
  }

  const code = requestUrl.searchParams.get('code')
  if (
    requestUrl.searchParams.has('error') ||
    code === null ||
    code === ''
  ) {
    return callbackFailure(400)
  }

  if (!hasWorksBindings(env)) return callbackFailure(400)

  const bindings = worksBindings(env)
  let identity
  try {
    const configuration = await getWorksConfiguration(
      bindings,
      fetcher,
      now,
    )
    const idToken = await exchangeAuthorizationCode(
      code,
      oauthState.code_verifier,
      callbackUri(request),
      bindings,
      configuration,
      fetcher,
    )
    identity = await verifyIdToken(
      idToken,
      {
        clientId: bindings.WORKS_CLIENT_ID,
        configuration,
        nonce: oauthState.nonce,
      },
      fetcher,
      now,
    )
  } catch {
    return callbackFailure(400)
  }

  let user: UserRow | null
  try {
    user = await claimUser(
      env.DB,
      identity.email,
      identity.sub,
      now,
    )
  } catch {
    return callbackFailure(403)
  }
  if (!user) return callbackFailure(403)

  try {
    const session = await createSession(
      env.DB,
      {
        userId: user.id,
        officeId: user.office_id,
      },
      now,
    )
    const redirectTo = safeRedirectTo(
      oauthState.redirect_to,
      requestUrl.origin,
    )

    const headers = new Headers()
    headers.append(
      'set-cookie',
      createSessionCookie(
        session.token,
        session.expiresAt,
      ),
    )
    headers.append('set-cookie', oauthStateCookie('', 0))
    return redirect(redirectTo, headers)
  } catch {
    return callbackFailure(500)
  }
}

function cookieValue(
  request: Request,
  name: string,
): string | undefined {
  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return undefined

  for (const part of cookieHeader.split(';')) {
    const cookie = part.trim()
    const separator = cookie.indexOf('=')
    if (
      separator >= 0 &&
      cookie.slice(0, separator) === name
    ) {
      return cookie.slice(separator + 1) || undefined
    }
  }

  return undefined
}

async function logout(request: Request, env: Env): Promise<Response> {
  const csrfError = csrfFailure(request)
  if (csrfError) return csrfError

  const token = cookieValue(request, SESSION_COOKIE_NAME)
  if (token) {
    const sessionId = await hashSessionToken(token)
    await env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?')
      .bind(sessionId)
      .run()
  }

  return new Response(null, {
    status: 204,
    headers: {
      'set-cookie': createSessionCookie('', 0),
      'cache-control': 'no-store',
    },
  })
}

export function createAuthRoutes(
  dependencies: AuthDependencies = {},
): Route[] {
  const clock = dependencies.clock ?? DEFAULT_CLOCK
  const fetcher = dependencies.fetcher ?? DEFAULT_FETCH

  return [
    {
      method: 'GET',
      path: '/api/auth/login',
      handler: (request, env) =>
        startLogin(request, env, clock, fetcher),
    },
    {
      method: 'GET',
      path: CALLBACK_PATH,
      handler: (request, env) =>
        finishLogin(request, env, clock, fetcher),
    },
    {
      method: 'POST',
      path: '/api/auth/logout',
      handler: logout,
    },
  ]
}

export const routes = createAuthRoutes()
