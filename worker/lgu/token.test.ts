import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  createApiPassword,
  createAuthRandomString,
  createLguTokenProvider,
  LguConfigurationError,
  TOKEN_USABLE_LIFETIME_MS,
  type LguTokenEnv,
  type LguTokenStore,
} from './token'
import type { LguFetch } from './protocol'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const NOW = 1_753_670_800_123
const AUTH_HOST = 'auth.example.test'
const API_KEY = 'api-key'
const API_PASSWORD = 'api-password'

interface StoredToken {
  accessToken: string
  expiresAt: number
  issuedAt?: number
}

class MemoryTokenStore implements LguTokenStore {
  record: StoredToken | null = null
  readCount = 0
  leaseUntil = 0

  async read(): Promise<StoredToken | null> {
    this.readCount += 1
    return this.record
  }

  async ensureRow(): Promise<void> {}

  async acquireLease(
    _officeId: string,
    now: number,
    leaseUntil: number,
  ): Promise<boolean> {
    if (
      this.leaseUntil > now ||
      (this.record !== null && this.record.expiresAt > now)
    ) {
      return false
    }

    this.leaseUntil = leaseUntil
    return true
  }

  async save(
    _officeId: string,
    token: StoredToken & { issuedAt: number },
    leaseUntil: number,
  ): Promise<boolean> {
    if (this.leaseUntil !== leaseUntil) {
      return false
    }

    this.record = token
    this.leaseUntil = 0
    return true
  }

  async releaseLease(
    _officeId: string,
    leaseUntil: number,
  ): Promise<void> {
    if (this.leaseUntil === leaseUntil) {
      this.leaseUntil = 0
    }
  }
}

function tokenEnv(overrides: Partial<LguTokenEnv> = {}): LguTokenEnv {
  return {
    DB: env.DB,
    LGU_AUTH_HOST: AUTH_HOST,
    LGU_API_KEY: API_KEY,
    LGU_API_PASSWORD: API_PASSWORD,
    ...overrides,
  }
}

function authResponse(accessToken: string): Response {
  return Response.json({
    code: '10000',
    accessToken,
  })
}

async function insertOffice(officeId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
  )
    .bind(officeId, '리치 세무법인', NOW)
    .run()
}

describe('LGU token provider', () => {
  it('builds apiPwd from raw SHA-512 digests', async () => {
    const actual = await createApiPassword('Pa$$w0rd!한글', 'Abc-123_XyZ')

    expect(actual).toBe(
      'LQdLq4MDrBEVQ0ObOTdgFsW7TRWV0ho65gGgJqPds5Mfm7gbKlrzAOAmcWtd7UU3nLP/7kkKhWwzTFPMefL22w==',
    )
    // hex 문자열을 base64한 구현은 이 값이 되어 위 벡터와 분명히 다르다.
    expect(actual).not.toBe(
      '6Crk6q0hkU5LzO/rB+TMVIS7s6sJ0sfc0H2fuZJCyTHuRTtHgfTVk3Hj9M4RdGWeRs2coOsRgFyQnmhhOrbfsA==',
    )
  })

  it('creates a fresh allowed random string per request', () => {
    const first = createAuthRandomString()
    const second = createAuthRandomString()

    expect(first).toMatch(/^[A-Za-z0-9_-]{20}$/)
    expect(second).toMatch(/^[A-Za-z0-9_-]{20}$/)
    expect(second).not.toBe(first)
  })

  it('uses one authentication request across ten isolate providers', async () => {
    const officeId = 'office-lgu-concurrent'
    await insertOffice(officeId)
    let authCalls = 0
    const fakeFetch: LguFetch = async () => {
      authCalls += 1
      return authResponse('shared-token')
    }
    const providers = Array.from({ length: 10 }, () =>
      createLguTokenProvider({
        fetch: fakeFetch,
        now: () => NOW,
      }),
    )

    const tokens = await Promise.all(
      providers.map((provider) => provider(tokenEnv(), officeId)),
    )

    expect(tokens).toEqual(Array.from({ length: 10 }, () => 'shared-token'))
    expect(authCalls).toBe(1)
    const stored = await env.DB.prepare(
      `SELECT issued_at, expires_at, lease_until
       FROM lgu_tokens
       WHERE office_id = ?`,
    )
      .bind(officeId)
      .first<{
        issued_at: number
        expires_at: number
        lease_until: number
      }>()
    expect(stored).toEqual({
      issued_at: NOW,
      expires_at: NOW + TOKEN_USABLE_LIFETIME_MS,
      lease_until: 0,
    })
  })

  it('returns a valid isolate cache without reading D1 or authenticating', async () => {
    const store = new MemoryTokenStore()
    let authCalls = 0
    const provider = createLguTokenProvider({
      fetch: async () => {
        authCalls += 1
        return authResponse('cached-token')
      },
      now: () => NOW,
      storeFactory: () => store,
    })

    await expect(provider(tokenEnv(), 'office-cache')).resolves.toBe(
      'cached-token',
    )
    const readsAfterAuthentication = store.readCount
    await expect(provider(tokenEnv(), 'office-cache')).resolves.toBe(
      'cached-token',
    )

    expect(store.readCount).toBe(readsAfterAuthentication)
    expect(authCalls).toBe(1)
  })

  it('reauthenticates exactly at the safety expiry boundary', async () => {
    const store = new MemoryTokenStore()
    let now = NOW
    let authCalls = 0
    const provider = createLguTokenProvider({
      fetch: async () => {
        authCalls += 1
        return authResponse(`token-${authCalls}`)
      },
      now: () => now,
      storeFactory: () => store,
    })

    await expect(provider(tokenEnv(), 'office-boundary')).resolves.toBe(
      'token-1',
    )
    now = NOW + TOKEN_USABLE_LIFETIME_MS - 1
    await expect(provider(tokenEnv(), 'office-boundary')).resolves.toBe(
      'token-1',
    )
    now += 1
    await expect(provider(tokenEnv(), 'office-boundary')).resolves.toBe(
      'token-2',
    )
    expect(authCalls).toBe(2)
  })

  it('fails clearly when a required secret is absent', async () => {
    const store = new MemoryTokenStore()
    const provider = createLguTokenProvider({
      fetch: async () => {
        throw new Error('인증 요청까지 진행하면 안 된다.')
      },
      now: () => NOW,
      storeFactory: () => store,
    })

    const error = await provider(
      tokenEnv({ LGU_API_KEY: undefined as unknown as string }),
      'office-no-secret',
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(LguConfigurationError)
    expect(error).toEqual(
      expect.objectContaining({
        name: 'LguConfigurationError',
        message: expect.stringContaining('LGU_API_KEY'),
      }),
    )
  })

  it('takes the authentication host from configuration', async () => {
    const store = new MemoryTokenStore()
    let requestedUrl = ''
    const provider = createLguTokenProvider({
      fetch: async (input) => {
        requestedUrl = String(input)
        return authResponse('configured-host-token')
      },
      now: () => NOW,
      randomString: () => 'fixed-random',
      storeFactory: () => store,
    })

    await provider(
      tokenEnv({ LGU_AUTH_HOST: 'configured-auth.example' }),
      'office-host',
    )

    expect(requestedUrl).toBe(
      'https://configured-auth.example/auth/v1/fixed-random',
    )
  })

  it('attaches Access headers to authentication requests', async () => {
    const store = new MemoryTokenStore()
    let requestedHeaders = new Headers()
    const provider = createLguTokenProvider({
      fetch: async (_input, init) => {
        requestedHeaders = new Headers(init?.headers)
        return authResponse('access-auth-token')
      },
      now: () => NOW,
      randomString: () => 'fixed-random',
      storeFactory: () => store,
    })

    await provider(
      tokenEnv({
        CF_ACCESS_CLIENT_ID: 'access-client-id',
        CF_ACCESS_CLIENT_SECRET: 'access-client-secret',
      }),
      'office-access-auth',
    )

    expect(requestedHeaders.get('CF-Access-Client-Id')).toBe(
      'access-client-id',
    )
    expect(requestedHeaders.get('CF-Access-Client-Secret')).toBe(
      'access-client-secret',
    )
  })
})
