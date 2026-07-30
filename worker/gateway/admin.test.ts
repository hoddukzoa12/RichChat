import { describe, expect, it, vi } from 'vitest'
import {
  GatewayAdminError,
  createGatewayAdminClient,
  type GatewayAdminEnv,
} from './admin'

const ENV: GatewayAdminEnv = {
  SMS_GATEWAY_API_URL:
    'https://sms-gateway.example/api/3rdparty/v1',
  SMS_GATEWAY_MOBILE_URL:
    'https://sms-mobile.example/api/mobile/v1',
  SMS_GATEWAY_USERNAME: 'rich-user',
  SMS_GATEWAY_PASSWORD: 'rich-password',
  CF_ACCESS_CLIENT_ID: 'access-id',
  CF_ACCESS_CLIENT_SECRET: 'access-secret',
}

describe('SMS Gateway admin client', () => {
  it('hands the phone the mobile URL, not the management host', async () => {
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

    // 관리 API는 Access 뒤에 있어 업무폰이 붙으면 403이다. 화면에 뜨는 값과
    // 코드 발급 요청 둘 다 업무폰 접속 주소를 써야 한다.
    await expect(client.issueEnrollmentCode(ENV)).resolves.toEqual({
      apiUrl: 'https://sms-mobile.example/api/mobile/v1',
      code: '123456',
      validUntil: '2026-07-30T10:05:00Z',
    })
    const [input, init] = fetcher.mock.calls[0]
    expect(String(input)).toBe(
      'https://sms-mobile.example/api/mobile/v1/user/code',
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

  it('refuses a mobile URL that is missing or points at the management path', async () => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json({})))
    const client = createGatewayAdminClient(fetcher)

    for (const [mobileUrl, expected] of [
      ['', '설정되지 않았습니다'],
      ['https://sms-mobile.example', '/api/mobile/v1'],
      ['https://sms-gateway.example/api/3rdparty/v1', '/api/mobile/v1'],
    ] as const) {
      await expect(
        client.issueEnrollmentCode({
          ...ENV,
          SMS_GATEWAY_MOBILE_URL: mobileUrl,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          name: 'GatewayAdminError',
          message: expect.stringContaining(expected),
        }) satisfies Partial<GatewayAdminError>,
      )
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('lists gateway devices', async () => {
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
        return Promise.resolve(Response.json([]))
      },
    )
    const client = createGatewayAdminClient(fetcher)

    await expect(client.listDevices(ENV)).resolves.toEqual([
      { id: 'device-1', name: '상담실 업무폰' },
    ])
    expect(String(fetcher.mock.calls[0][0])).toBe(
      'https://sms-gateway.example/api/3rdparty/v1/devices',
    )
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
