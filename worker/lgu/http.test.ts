import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  createLguHttpClient,
  LguApiError,
  LguNetworkError,
  type LguHttpEnv,
} from './http'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

function httpEnv(overrides: Partial<LguHttpEnv> = {}): LguHttpEnv {
  return {
    DB: env.DB,
    LGU_AUTH_HOST: 'auth.example.test',
    LGU_SEND_HOST: 'send.example.test',
    LGU_CONTENT_HOST: 'content.example.test',
    LGU_API_KEY: 'api-key',
    LGU_API_PASSWORD: 'api-password',
    ...overrides,
  }
}

describe('LGU HTTP client', () => {
  it('uses the configured host and attaches the bearer token', async () => {
    let requestedUrl = ''
    let requestedHeaders = new Headers()
    const request = createLguHttpClient({
      tokenProvider: async () => 'access-token',
      fetch: async (input, init) => {
        requestedUrl = String(input)
        requestedHeaders = new Headers(init?.headers)
        return Response.json({ code: '10000', result: 'accepted' })
      },
    })

    const result = await request<{ code: string; result: string }>(
      httpEnv(),
      'office-http',
      'send',
      '/message/v1/send',
      { method: 'POST' },
    )

    expect(result).toEqual({ code: '10000', result: 'accepted' })
    expect(requestedUrl).toBe('https://send.example.test/message/v1/send')
    expect(requestedHeaders.get('authorization')).toBe('Bearer access-token')
  })

  it('attaches Access headers to send requests', async () => {
    let requestedHeaders = new Headers()
    const request = createLguHttpClient({
      tokenProvider: async () => 'access-token',
      fetch: async (_input, init) => {
        requestedHeaders = new Headers(init?.headers)
        return Response.json({ code: '10000' })
      },
    })

    await request(
      httpEnv({
        CF_ACCESS_CLIENT_ID: 'access-client-id',
        CF_ACCESS_CLIENT_SECRET: 'access-client-secret',
      }),
      'office-access',
      'send',
      '/message/v1/send',
    )

    expect(requestedHeaders.get('CF-Access-Client-Id')).toBe(
      'access-client-id',
    )
    expect(requestedHeaders.get('CF-Access-Client-Secret')).toBe(
      'access-client-secret',
    )
  })

  it('omits Access headers when the service token is absent', async () => {
    let requestedHeaders = new Headers()
    const request = createLguHttpClient({
      tokenProvider: async () => 'access-token',
      fetch: async (_input, init) => {
        requestedHeaders = new Headers(init?.headers)
        return Response.json({ code: '10000' })
      },
    })

    await request(
      httpEnv(),
      'office-no-access',
      'send',
      '/message/v1/send',
    )

    expect(requestedHeaders.has('CF-Access-Client-Id')).toBe(false)
    expect(requestedHeaders.has('CF-Access-Client-Secret')).toBe(false)
  })

  it('retains the LGU failure code and response body', async () => {
    const request = createLguHttpClient({
      tokenProvider: async () => 'access-token',
      fetch: async () =>
        Response.json({ code: '40017', message: 'invalid callback' }),
    })

    const error = await request(
      httpEnv(),
      'office-api-error',
      'content',
      '/content/v1/upload',
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(LguApiError)
    expect(error).toEqual(
      expect.objectContaining({
        name: 'LguApiError',
        code: '40017',
        rawBody: expect.stringContaining('invalid callback'),
      }),
    )
  })

  it('distinguishes network failures from API failures', async () => {
    const networkCause = new TypeError('connection reset')
    const request = createLguHttpClient({
      tokenProvider: async () => 'access-token',
      fetch: async () => {
        throw networkCause
      },
    })

    const error = await request(
      httpEnv(),
      'office-network-error',
      'send',
      '/message/v1/send',
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(LguNetworkError)
    expect(error).toEqual(
      expect.objectContaining({
        name: 'LguNetworkError',
        cause: networkCause,
      }),
    )
  })
})
