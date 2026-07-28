import { changes } from '../db/d1'
import {
  fetchLguJson,
  LguApiError,
  type LguFetch,
} from './protocol'

const TOKEN_ACTUAL_LIFETIME_MS = 60 * 60 * 1_000
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1_000
export const TOKEN_USABLE_LIFETIME_MS =
  TOKEN_ACTUAL_LIFETIME_MS - TOKEN_EXPIRY_MARGIN_MS

const LEASE_DURATION_MS = 30_000
const LEASE_POLL_INTERVAL_MS = 25
const RANDOM_STRING_LENGTH = 20

interface TokenRecord {
  accessToken: string
  expiresAt: number
}

export interface LguTokenStore {
  read(officeId: string): Promise<TokenRecord | null>
  ensureRow(officeId: string): Promise<void>
  acquireLease(
    officeId: string,
    now: number,
    leaseUntil: number,
  ): Promise<boolean>
  save(
    officeId: string,
    token: TokenRecord & { issuedAt: number },
    leaseUntil: number,
  ): Promise<boolean>
  releaseLease(officeId: string, leaseUntil: number): Promise<void>
}

export class D1LguTokenStore implements LguTokenStore {
  constructor(private readonly db: D1Database) {}

  async read(officeId: string): Promise<TokenRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT access_token, expires_at
         FROM lgu_tokens
         WHERE office_id = ?`,
      )
      .bind(officeId)
      .first<{ access_token: string; expires_at: number }>()

    if (row === null) {
      return null
    }

    return {
      accessToken: row.access_token,
      expiresAt: row.expires_at,
    }
  }

  async ensureRow(officeId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO lgu_tokens
           (office_id, access_token, issued_at, expires_at, lease_until)
         VALUES (?, '', 0, 0, 0)
         ON CONFLICT(office_id) DO NOTHING`,
      )
      .bind(officeId)
      .run()
  }

  async acquireLease(
    officeId: string,
    now: number,
    leaseUntil: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE lgu_tokens
         SET lease_until = ?
         WHERE office_id = ?
           AND expires_at <= ?
           AND lease_until <= ?`,
      )
      .bind(leaseUntil, officeId, now, now)
      .run()

    return changes(result) === 1
  }

  async save(
    officeId: string,
    token: TokenRecord & { issuedAt: number },
    leaseUntil: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE lgu_tokens
         SET access_token = ?, issued_at = ?, expires_at = ?, lease_until = 0
         WHERE office_id = ? AND lease_until = ?`,
      )
      .bind(
        token.accessToken,
        token.issuedAt,
        token.expiresAt,
        officeId,
        leaseUntil,
      )
      .run()

    return changes(result) === 1
  }

  async releaseLease(officeId: string, leaseUntil: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE lgu_tokens
         SET lease_until = 0
         WHERE office_id = ? AND lease_until = ?`,
      )
      .bind(officeId, leaseUntil)
      .run()
  }
}

export interface LguTokenEnv {
  DB: D1Database
  LGU_AUTH_HOST: string
  LGU_API_KEY: string
  LGU_API_PASSWORD: string
}

interface AuthResponse {
  code: string
  accessToken?: unknown
}

interface TokenProviderOptions {
  fetch?: LguFetch
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  randomString?: () => string
  storeFactory?: (db: D1Database) => LguTokenStore
}

export type LguTokenProvider = (
  env: LguTokenEnv,
  officeId: string,
) => Promise<string>

export class LguConfigurationError extends Error {
  constructor(binding: string) {
    super(`LGU+ 필수 바인딩 ${binding}이(가) 설정되지 않았습니다.`)
    this.name = 'LguConfigurationError'
  }
}

function requireBinding(value: unknown, binding: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LguConfigurationError(binding)
  }

  return value
}

function isUsable(token: TokenRecord | null, now: number): token is TokenRecord {
  return token !== null && token.accessToken !== '' && token.expiresAt > now
}

function bytesToBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

async function sha512Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-512',
    new TextEncoder().encode(value),
  )
  return bytesToBase64(digest)
}

export async function createApiPassword(
  password: string,
  randomString: string,
): Promise<string> {
  const firstDigest = await sha512Base64(password)
  return await sha512Base64(`${firstDigest}.${randomString}`)
}

export function createAuthRandomString(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, RANDOM_STRING_LENGTH)
}

async function authenticate(
  env: LguTokenEnv,
  fetcher: LguFetch,
  randomString: string,
): Promise<string> {
  const host = requireBinding(env.LGU_AUTH_HOST, 'LGU_AUTH_HOST')
  const apiKey = requireBinding(env.LGU_API_KEY, 'LGU_API_KEY')
  const password = requireBinding(env.LGU_API_PASSWORD, 'LGU_API_PASSWORD')
  const apiPwd = await createApiPassword(password, randomString)
  const response = await fetchLguJson<AuthResponse>(
    fetcher,
    `https://${host}/auth/v1/${randomString}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey, apiPwd }),
    },
  )

  if (typeof response.accessToken !== 'string' || response.accessToken === '') {
    throw new LguApiError(
      'INVALID_RESPONSE',
      200,
      JSON.stringify(response),
      response,
    )
  }

  return response.accessToken
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

export function createLguTokenProvider(
  options: TokenProviderOptions = {},
): LguTokenProvider {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const randomString = options.randomString ?? createAuthRandomString
  const storeFactory =
    options.storeFactory ?? ((db: D1Database) => new D1LguTokenStore(db))
  const cache = new Map<string, TokenRecord>()
  const pending = new Map<string, Promise<string>>()

  async function load(env: LguTokenEnv, officeId: string): Promise<string> {
    const store = storeFactory(env.DB)

    while (true) {
      const currentTime = now()
      const stored = await store.read(officeId)
      if (isUsable(stored, currentTime)) {
        cache.set(officeId, stored)
        return stored.accessToken
      }

      await store.ensureRow(officeId)
      const leaseUntil = currentTime + LEASE_DURATION_MS
      const acquired = await store.acquireLease(
        officeId,
        currentTime,
        leaseUntil,
      )

      if (!acquired) {
        await sleep(LEASE_POLL_INTERVAL_MS)
        continue
      }

      try {
        const accessToken = await authenticate(
          env,
          fetcher,
          randomString(),
        )
        const issuedAt = now()
        const token = {
          accessToken,
          issuedAt,
          expiresAt: issuedAt + TOKEN_USABLE_LIFETIME_MS,
        }
        const saved = await store.save(officeId, token, leaseUntil)
        if (saved) {
          cache.set(officeId, token)
          return accessToken
        }
      } catch (cause) {
        try {
          await store.releaseLease(officeId, leaseUntil)
        } catch (releaseCause) {
          throw new AggregateError(
            [cause, releaseCause],
            'LGU+ 인증 실패 후 토큰 리스를 해제하지 못했습니다.',
          )
        }
        throw cause
      }
    }
  }

  return async (env: LguTokenEnv, officeId: string): Promise<string> => {
    const cached = cache.get(officeId) ?? null
    if (isUsable(cached, now())) {
      return cached.accessToken
    }

    const existing = pending.get(officeId)
    if (existing !== undefined) {
      return await existing
    }

    const promise = load(env, officeId)
    pending.set(officeId, promise)
    try {
      return await promise
    } finally {
      if (pending.get(officeId) === promise) {
        pending.delete(officeId)
      }
    }
  }
}

export const getLguAccessToken = createLguTokenProvider()
