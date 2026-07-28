import { env, fetchMock, SELF } from 'cloudflare:test'
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest'
import type { UserStatus } from '../../shared/domain'
import {
  hashSessionToken,
  SESSION_COOKIE_NAME,
} from '../http/session'
import { routes as authRoutes } from './auth'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const DISCOVERY_ORIGIN = 'https://auth.worksmobile.com'
const OIDC_ORIGIN = 'https://oidc.test'
const ISSUER = 'https://issuer.test'
const CLIENT_ID = 'test-works-client-id'
const CLIENT_SECRET = 'test-works-client-secret'
const TENANT_ID = 'test-works-tenant-id'
const DISCOVERY_PATH =
  `/${TENANT_ID}/.well-known/openid-configuration`
const TOKEN_PATH = '/token'
const JWKS_PATH = '/jwks'

interface SeedUserOptions {
  email?: string
  status?: UserStatus
  subject?: string | null
}

interface LoginAttempt {
  authorizationUrl: URL
  nonce: string
  state: string
}

interface TokenRequest {
  code: string
  codeVerifier: string
  clientSecret: string
}

interface SigningMaterial {
  kid: string
  privateKey: CryptoKey
  publicJwk: TestJwk
}

interface TestJwk extends JsonWebKey {
  alg: string
  kid: string
  use: string
}

interface IdTokenOverrides {
  aud?: string | string[]
  email?: string
  exp?: number
  iat?: number
  iss?: string
  nonce?: string
  sub?: string
}

const tokensByCode = new Map<string, string>()
const tokenRequests: TokenRequest[] = []
let activeJwks: TestJwk[] = []
let discoveryRequestCount = 0
let jwksRequestCount = 0
let primaryKey: SigningMaterial
let rolloverKey: SigningMaterial
let forgedKey: SigningMaterial
let codeSequence = 0

function base64Url(value: Uint8Array | string): string {
  const bytes =
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

async function signingMaterial(kid: string): Promise<SigningMaterial> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey)

  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: {
      ...exported,
      alg: 'RS256',
      kid,
      use: 'sig',
    },
  }
}

async function idToken(
  key: SigningMaterial,
  nonce: string,
  overrides: IdTokenOverrides = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1_000)
  const header = base64Url(
    JSON.stringify({
      alg: 'RS256',
      kid: key.kid,
      typ: 'JWT',
    }),
  )
  const payload = base64Url(
    JSON.stringify({
      iss: overrides.iss ?? ISSUER,
      sub: overrides.sub ?? 'works-subject-1',
      aud: overrides.aud ?? CLIENT_ID,
      nonce: overrides.nonce ?? nonce,
      email: overrides.email ?? 'invitee@rich.example',
      iat: overrides.iat ?? nowSeconds - 1,
      exp: overrides.exp ?? nowSeconds + 3_600,
    }),
  )
  const signingInput = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(signingInput),
  )

  return `${signingInput}.${base64Url(new Uint8Array(signature))}`
}

function formBody(value: unknown): URLSearchParams {
  if (typeof value !== 'string') return new URLSearchParams()
  return new URLSearchParams(value)
}

beforeAll(async () => {
  ;[primaryKey, rolloverKey, forgedKey] = await Promise.all([
    signingMaterial('test-key-primary'),
    signingMaterial('test-key-rollover'),
    signingMaterial('test-key-primary'),
  ])
  activeJwks = [primaryKey.publicJwk]

  fetchMock.activate()
  fetchMock.disableNetConnect()
  fetchMock
    .get(DISCOVERY_ORIGIN)
    .intercept({
      method: 'GET',
      path: DISCOVERY_PATH,
    })
    .reply(() => {
      discoveryRequestCount += 1
      return {
        statusCode: 200,
        data: JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${OIDC_ORIGIN}/authorize`,
          token_endpoint: `${OIDC_ORIGIN}${TOKEN_PATH}`,
          jwks_uri: `${OIDC_ORIGIN}${JWKS_PATH}`,
        }),
        responseOptions: {
          headers: { 'content-type': 'application/json' },
        },
      }
    })
    .persist()

  fetchMock
    .get(OIDC_ORIGIN)
    .intercept({
      method: 'GET',
      path: JWKS_PATH,
    })
    .reply(() => {
      jwksRequestCount += 1
      return {
        statusCode: 200,
        data: JSON.stringify({ keys: activeJwks }),
        responseOptions: {
          headers: { 'content-type': 'application/json' },
        },
      }
    })
    .persist()

  fetchMock
    .get(OIDC_ORIGIN)
    .intercept({
      method: 'POST',
      path: TOKEN_PATH,
    })
    .reply(({ body }) => {
      const form = formBody(body)
      const code = form.get('code') ?? ''
      const clientSecret = form.get('client_secret') ?? ''
      tokenRequests.push({
        code,
        codeVerifier: form.get('code_verifier') ?? '',
        clientSecret,
      })
      const token = tokensByCode.get(code)

      if (
        clientSecret !== CLIENT_SECRET ||
        form.get('client_id') !== CLIENT_ID
      ) {
        return {
          statusCode: 401,
          data: JSON.stringify({ error: 'invalid_client' }),
          responseOptions: {
            headers: { 'content-type': 'application/json' },
          },
        }
      }

      if (!token) {
        return {
          statusCode: 400,
          data: JSON.stringify({ error: 'invalid_grant' }),
          responseOptions: {
            headers: { 'content-type': 'application/json' },
          },
        }
      }

      return {
        statusCode: 200,
        data: JSON.stringify({ id_token: token }),
        responseOptions: {
          headers: { 'content-type': 'application/json' },
        },
      }
    })
    .persist()
})

afterAll(() => {
  fetchMock.deactivate()
})

async function seedUser(
  options: SeedUserOptions = {},
): Promise<{ officeId: string; userId: string }> {
  const officeId = 'office-oidc'
  const userId = 'user-oidc'
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, works_sub, name, title, role, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      officeId,
      options.email ?? 'invitee@rich.example',
      options.subject ?? null,
      '박상담',
      '상담 담당',
      '상담 담당',
      options.status ?? '초대',
      now,
      now,
    ),
  ])

  return { officeId, userId }
}

async function beginLogin(redirectTo?: string): Promise<LoginAttempt> {
  const url = new URL('/api/auth/login', ORIGIN)
  if (redirectTo !== undefined) {
    url.searchParams.set('redirect_to', redirectTo)
  }

  const response = await SELF.fetch(url.toString(), {
    redirect: 'manual',
  })
  expect(response.status).toBe(302)

  const location = response.headers.get('location')
  expect(location).not.toBeNull()
  const authorizationUrl = new URL(location ?? ORIGIN)
  expect(authorizationUrl.origin).toBe(OIDC_ORIGIN)
  expect(authorizationUrl.pathname).toBe('/authorize')
  expect(authorizationUrl.searchParams.get('response_type')).toBe(
    'code',
  )
  expect(authorizationUrl.searchParams.get('scope')).toBe(
    'openid email',
  )
  expect(
    authorizationUrl.searchParams.get('code_challenge_method'),
  ).toBe('S256')

  return {
    authorizationUrl,
    nonce: authorizationUrl.searchParams.get('nonce') ?? '',
    state: authorizationUrl.searchParams.get('state') ?? '',
  }
}

async function prepareCallback(
  attempt: LoginAttempt,
  overrides: IdTokenOverrides = {},
  key = primaryKey,
): Promise<{ callbackUrl: string; code: string }> {
  codeSequence += 1
  const code = `test-code-${codeSequence}`
  tokensByCode.set(code, await idToken(key, attempt.nonce, overrides))
  const callbackUrl = new URL('/api/auth/callback', ORIGIN)
  callbackUrl.searchParams.set('code', code)
  callbackUrl.searchParams.set('state', attempt.state)
  return { callbackUrl: callbackUrl.toString(), code }
}

function sessionToken(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? ''
  const firstPart = setCookie.split(';', 1)[0]
  expect(firstPart.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  return firstPart.slice(`${SESSION_COOKIE_NAME}=`.length)
}

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return base64Url(new Uint8Array(digest))
}

function route(method: string, path: string) {
  const selected = authRoutes.find(
    (candidate) =>
      candidate.method === method && candidate.path === path,
  )
  expect(selected).toBeDefined()
  return selected
}

describe('NAVER WORKS OIDC authentication', () => {
  it('uses PKCE and activates an invited user with a B4-compatible session', async () => {
    const { userId } = await seedUser()
    const attempt = await beginLogin('/inbox?view=mine')
    const { callbackUrl, code } = await prepareCallback(attempt)

    const response = await SELF.fetch(callbackUrl, {
      redirect: 'manual',
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/inbox?view=mine')
    const token = sessionToken(response)
    const request = tokenRequests.find(
      (candidate) => candidate.code === code,
    )
    expect(request?.clientSecret).toBe(CLIENT_SECRET)
    expect(request?.codeVerifier).not.toBe('')
    await expect(
      sha256Base64Url(request?.codeVerifier ?? ''),
    ).resolves.toBe(
      attempt.authorizationUrl.searchParams.get('code_challenge'),
    )

    const user = await env.DB.prepare(
      'SELECT works_sub, status FROM users WHERE id = ?',
    )
      .bind(userId)
      .first<{ works_sub: string; status: UserStatus }>()
    expect(user).toEqual({
      works_sub: 'works-subject-1',
      status: '활성',
    })

    const me = await SELF.fetch(`${ORIGIN}/api/me`, {
      headers: { cookie: cookie(token) },
    })
    expect(me.status).toBe(200)
  })

  it('consumes a state exactly once with DELETE RETURNING', async () => {
    await seedUser()
    const attempt = await beginLogin()
    const { callbackUrl } = await prepareCallback(attempt)

    const first = await SELF.fetch(callbackUrl, {
      redirect: 'manual',
    })
    const second = await SELF.fetch(callbackUrl, {
      redirect: 'manual',
    })

    expect(first.status).toBe(302)
    expect(second.status).toBe(400)
    expect(second.headers.get('content-type')).toContain('text/html')
  })

  it('rejects and removes an expired state', async () => {
    const attempt = await beginLogin()
    await env.DB.prepare(
      'UPDATE oauth_states SET expires_at = ? WHERE state = ?',
    )
      .bind(Date.now() - 1, attempt.state)
      .run()
    const { callbackUrl } = await prepareCallback(attempt)

    const response = await SELF.fetch(callbackUrl, {
      redirect: 'manual',
    })

    expect(response.status).toBe(400)
    const state = await env.DB.prepare(
      'SELECT state FROM oauth_states WHERE state = ?',
    )
      .bind(attempt.state)
      .first()
    expect(state).toBeNull()
  })

  it('cleans expired states when starting a login', async () => {
    await env.DB.prepare(
      `INSERT INTO oauth_states (
        state, nonce, code_verifier, redirect_to, expires_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('expired-state', 'nonce', 'verifier', '/', Date.now() - 1)
      .run()

    await beginLogin()

    const expired = await env.DB.prepare(
      'SELECT state FROM oauth_states WHERE state = ?',
    )
      .bind('expired-state')
      .first()
    expect(expired).toBeNull()
  })

  it('rejects an uninvited email without creating a user', async () => {
    const attempt = await beginLogin()
    const { callbackUrl } = await prepareCallback(attempt, {
      email: 'not-invited@rich.example',
    })

    const response = await SELF.fetch(callbackUrl, {
      redirect: 'manual',
    })

    expect(response.status).toBe(403)
    const body = await response.text()
    expect(body).not.toContain('초대')
    expect(body).not.toContain('not-invited@rich.example')
    const user = await env.DB.prepare(
      'SELECT id FROM users WHERE email = ?',
    )
      .bind('not-invited@rich.example')
      .first()
    expect(user).toBeNull()
  })

  it('rejects an inactive user without disclosing the status', async () => {
    await seedUser({
      status: '비활성',
      subject: 'works-subject-1',
    })
    const attempt = await beginLogin()
    const { callbackUrl } = await prepareCallback(attempt)

    const response = await SELF.fetch(callbackUrl, {
      redirect: 'manual',
    })

    expect(response.status).toBe(403)
    const body = await response.text()
    expect(body).not.toContain('비활성')
    expect(body).not.toContain('초대')
  })

  it('rejects a nonce mismatch', async () => {
    await seedUser()
    const attempt = await beginLogin()
    const { callbackUrl } = await prepareCallback(attempt, {
      nonce: 'different-nonce',
    })

    const response = await SELF.fetch(callbackUrl, {
      redirect: 'manual',
    })

    expect(response.status).toBe(400)
    const user = await env.DB.prepare(
      'SELECT status FROM users WHERE id = ?',
    )
      .bind('user-oidc')
      .first<{ status: UserStatus }>()
    expect(user?.status).toBe('초대')
  })

  it('rejects an ID token with a forged signature', async () => {
    activeJwks = [primaryKey.publicJwk]
    await seedUser()
    const attempt = await beginLogin()
    const { callbackUrl } = await prepareCallback(
      attempt,
      {},
      forgedKey,
    )

    const response = await SELF.fetch(callbackUrl, {
      redirect: 'manual',
    })

    expect(response.status).toBe(400)
  })

  it('rejects an expired ID token', async () => {
    activeJwks = [primaryKey.publicJwk]
    await seedUser()
    const attempt = await beginLogin()
    const nowSeconds = Math.floor(Date.now() / 1_000)
    const { callbackUrl } = await prepareCallback(attempt, {
      iat: nowSeconds - 3_600,
      exp: nowSeconds - 1,
    })

    const response = await SELF.fetch(callbackUrl, {
      redirect: 'manual',
    })

    expect(response.status).toBe(400)
  })

  it.each([
    {
      label: 'issuer',
      overrides: { iss: 'https://forged-issuer.test' },
    },
    {
      label: 'audience',
      overrides: { aud: 'different-client-id' },
    },
  ])('rejects a token with the wrong $label', async ({ overrides }) => {
    activeJwks = [primaryKey.publicJwk]
    await seedUser()
    const attempt = await beginLogin()
    const { callbackUrl } = await prepareCallback(attempt, overrides)

    const response = await SELF.fetch(callbackUrl, {
      redirect: 'manual',
    })

    expect(response.status).toBe(400)
  })

  it('issues different session tokens for repeated logins', async () => {
    await seedUser()
    const firstAttempt = await beginLogin()
    const firstCallback = await prepareCallback(firstAttempt)
    const firstResponse = await SELF.fetch(firstCallback.callbackUrl, {
      redirect: 'manual',
    })

    const secondAttempt = await beginLogin()
    const secondCallback = await prepareCallback(secondAttempt)
    const secondResponse = await SELF.fetch(
      secondCallback.callbackUrl,
      { redirect: 'manual' },
    )

    const firstToken = sessionToken(firstResponse)
    const secondToken = sessionToken(secondResponse)
    expect(firstToken).not.toBe(secondToken)
    const sessions = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM auth_sessions',
    ).first<{ count: number }>()
    expect(sessions?.count).toBe(2)
  })

  it('deletes the database session on logout', async () => {
    await seedUser()
    const attempt = await beginLogin()
    const callback = await prepareCallback(attempt)
    const login = await SELF.fetch(callback.callbackUrl, {
      redirect: 'manual',
    })
    const token = sessionToken(login)
    const sessionId = await hashSessionToken(token)

    const logout = await SELF.fetch(`${ORIGIN}/api/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: cookie(token),
        origin: ORIGIN,
      },
    })

    expect(logout.status).toBe(204)
    expect(logout.headers.get('set-cookie')).toContain(
      `${SESSION_COOKIE_NAME}=`,
    )
    const stored = await env.DB.prepare(
      'SELECT id FROM auth_sessions WHERE id = ?',
    )
      .bind(sessionId)
      .first()
    expect(stored).toBeNull()
    const me = await SELF.fetch(`${ORIGIN}/api/me`, {
      headers: { cookie: cookie(token) },
    })
    expect(me.status).toBe(401)
  })

  it.each(['//evil.com', 'https://evil.com'])(
    'does not redirect outside the app for %s',
    async (redirectTo) => {
      await seedUser()
      const attempt = await beginLogin(redirectTo)
      const callback = await prepareCallback(attempt)

      const response = await SELF.fetch(callback.callbackUrl, {
        redirect: 'manual',
      })

      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/')
      expect(response.headers.get('location')).not.toContain(
        'evil.com',
      )
    },
  )

  it('refreshes cached JWKS after key rollover', async () => {
    await seedUser()
    activeJwks = [primaryKey.publicJwk]
    const firstAttempt = await beginLogin()
    const firstCallback = await prepareCallback(firstAttempt)
    const first = await SELF.fetch(firstCallback.callbackUrl, {
      redirect: 'manual',
    })
    expect(first.status).toBe(302)
    const afterFirst = jwksRequestCount

    activeJwks = [rolloverKey.publicJwk]
    const secondAttempt = await beginLogin()
    const secondCallback = await prepareCallback(
      secondAttempt,
      {},
      rolloverKey,
    )
    const second = await SELF.fetch(secondCallback.callbackUrl, {
      redirect: 'manual',
    })

    expect(second.status).toBe(302)
    expect(jwksRequestCount).toBeGreaterThan(afterFirst)
    activeJwks = [primaryKey.publicJwk]
  })

  it('caches OIDC discovery between login attempts', async () => {
    const before = discoveryRequestCount

    await beginLogin()
    await beginLogin()

    expect(discoveryRequestCount - before).toBeLessThanOrEqual(1)
  })

  it('rejects a callback when the client secret is wrong', async () => {
    await seedUser()
    const attempt = await beginLogin()
    const callback = await prepareCallback(attempt)
    const callbackRoute = route('GET', '/api/auth/callback')
    const wrongSecretEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === 'WORKS_CLIENT_SECRET') {
          return 'test-wrong-secret'
        }
        return Reflect.get(target, property, receiver)
      },
    }) as Env

    const response = await callbackRoute?.handler(
      new Request(callback.callbackUrl),
      wrongSecretEnv,
      {},
    )

    expect(response?.status).toBe(400)
    expect(await response?.text()).not.toContain('invalid_client')
  })

  it('keeps login closed when an OIDC binding is missing', async () => {
    const loginRoute = route('GET', '/api/auth/login')
    const missingBindingEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === 'WORKS_CLIENT_SECRET') return undefined
        return Reflect.get(target, property, receiver)
      },
    }) as Env

    const response = await loginRoute?.handler(
      new Request(`${ORIGIN}/api/auth/login`),
      missingBindingEnv,
      {},
    )

    expect(response?.status).toBe(404)
  })
})
