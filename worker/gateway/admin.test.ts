import { describe, expect, it, vi } from 'vitest'
import {
  GatewayAdminError,
  createGatewayAdminClient,
  type GatewayAdminEnv,
} from './admin'

const ENV: GatewayAdminEnv = {
  SMS_GATEWAY_API_URL:
    'https://sms-gateway.example/api/3rdparty/v1',
  SMS_GATEWAY_USERNAME: 'rich-user',
  SMS_GATEWAY_PASSWORD: 'rich-password',
  CF_ACCESS_CLIENT_ID: 'access-id',
  CF_ACCESS_CLIENT_SECRET: 'access-secret',
}

describe('SMS Gateway admin client', () => {
  it('derives the mobile code endpoint from the management URL', async () => {
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          Response.json({
            code: '123456',
            validUntil: '2026-07-30T10:05:00Z',
          }),
        ),
    )
    const client = createGatewayAdminClient(fetcher)

    await expect(client.issueEnrollmentCode(ENV)).resolves.toEqual({
      apiUrl: 'https://sms-gateway.example',
      code: '123456',
      validUntil: '2026-07-30T10:05:00Z',
    })
    const [input, init] = fetcher.mock.calls[0]
    expect(String(input)).toBe(
      'https://sms-gateway.example/api/mobile/v1/user/code',
    )
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(
      `Basic ${btoa('rich-user:rich-password')}`,
    )
    expect(headers.get('CF-Access-Client-Id')).toBe('access-id')
    expect(headers.get('CF-Access-Client-Secret')).toBe(
      'access-secret',
    )
  })

  it('lists devices and deploys the exact shared signing key', async () => {
    const fetcher = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).endsWith('/devices')) {
          return Promise.resolve(
            Response.json([
              {
                id: 'device-1',
                name: '상담실 업무폰',
                simCards: [],
              },
            ]),
          )
        }
        return Promise.resolve(Response.json({ webhooks: {} }))
      },
    )
    const client = createGatewayAdminClient(fetcher)

    await expect(client.listDevices(ENV)).resolves.toEqual([
      { id: 'device-1', name: '상담실 업무폰' },
    ])
    await client.deploySigningKey(ENV, 'shared-signing-key')

    expect(String(fetcher.mock.calls[1][0])).toBe(
      'https://sms-gateway.example/api/3rdparty/v1/settings',
    )
    expect(fetcher.mock.calls[1][1]?.method).toBe('PATCH')
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      webhooks: { signing_key: 'shared-signing-key' },
    })
  })

  it('turns gateway failures into a readable error', async () => {
    const client = createGatewayAdminClient(() =>
      Promise.resolve(new Response(null, { status: 403 })),
    )

    await expect(client.listDevices(ENV)).rejects.toEqual(
      expect.objectContaining({
        name: 'GatewayAdminError',
        message: expect.stringContaining('Access 정책'),
      }) satisfies Partial<GatewayAdminError>,
    )
  })
})
