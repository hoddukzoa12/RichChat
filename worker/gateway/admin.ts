export interface GatewayAdminEnv {
  SMS_GATEWAY_API_URL: string
  SMS_GATEWAY_USERNAME: string
  SMS_GATEWAY_PASSWORD: string
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
}

export interface GatewayEnrollmentCode {
  apiUrl: string
  code: string
  validUntil: string
}

export interface GatewayDevice {
  id: string
  name: string
}

type GatewayFetch = typeof fetch

const MANAGEMENT_PATH = '/api/3rdparty/v1'
const MOBILE_CODE_PATH = '/api/mobile/v1/user/code'

export class GatewayAdminError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GatewayAdminError'
  }
}

function configured(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function gatewayUrls(rawUrl: string): {
  apiUrl: string
  managementUrl: URL
  mobileCodeUrl: URL
} {
  let managementUrl: URL
  try {
    managementUrl = new URL(rawUrl)
  } catch (cause) {
    throw new GatewayAdminError(
      'SMS Gateway 관리 API 주소가 올바르지 않습니다.',
      { cause },
    )
  }

  const pathname = managementUrl.pathname.replace(/\/+$/, '')
  if (
    !['http:', 'https:'].includes(managementUrl.protocol) ||
    managementUrl.username !== '' ||
    managementUrl.password !== '' ||
    managementUrl.search !== '' ||
    managementUrl.hash !== '' ||
    pathname !== MANAGEMENT_PATH
  ) {
    throw new GatewayAdminError(
      `SMS Gateway 관리 API 주소는 ${MANAGEMENT_PATH} 경로까지 입력해야 합니다.`,
    )
  }
  managementUrl.pathname = pathname

  const mobileCodeUrl = new URL(managementUrl.origin)
  mobileCodeUrl.pathname = MOBILE_CODE_PATH
  return {
    apiUrl: managementUrl.origin,
    managementUrl,
    mobileCodeUrl,
  }
}

function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

function requestHeaders(
  env: GatewayAdminEnv,
  jsonBody: boolean,
): Headers {
  if (
    !configured(env.SMS_GATEWAY_USERNAME) ||
    !configured(env.SMS_GATEWAY_PASSWORD)
  ) {
    throw new GatewayAdminError(
      'SMS Gateway 계정 자격이 설정되지 않았습니다.',
    )
  }

  const headers = new Headers({
    accept: 'application/json',
    authorization: basicAuthorization(
      env.SMS_GATEWAY_USERNAME,
      env.SMS_GATEWAY_PASSWORD,
    ),
  })
  if (jsonBody) headers.set('content-type', 'application/json')

  if (
    configured(env.CF_ACCESS_CLIENT_ID) &&
    configured(env.CF_ACCESS_CLIENT_SECRET)
  ) {
    headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID)
    headers.set(
      'CF-Access-Client-Secret',
      env.CF_ACCESS_CLIENT_SECRET,
    )
  }
  return headers
}

function gatewayStatusMessage(status: number): string {
  if (status === 401) {
    return 'SMS Gateway 계정 인증에 실패했습니다.'
  }
  if (status === 403) {
    return 'SMS Gateway 관리 API에 접근할 수 없습니다. Access 정책을 확인해 주세요.'
  }
  if (status === 429) {
    return 'SMS Gateway 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
  }
  return `SMS Gateway 관리 API 요청에 실패했습니다. (${status})`
}

async function gatewayRequest(
  fetcher: GatewayFetch,
  env: GatewayAdminEnv,
  url: URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = requestHeaders(
    env,
    init.body !== undefined && init.body !== null,
  )
  let response: Response
  try {
    response = await fetcher(url, {
      ...init,
      headers,
    })
  } catch (cause) {
    throw new GatewayAdminError(
      'SMS Gateway 관리 API에 연결할 수 없습니다.',
      { cause },
    )
  }

  if (!response.ok) {
    throw new GatewayAdminError(
      gatewayStatusMessage(response.status),
    )
  }
  return response
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (cause) {
    throw new GatewayAdminError(
      'SMS Gateway 관리 API가 올바르지 않은 응답을 보냈습니다.',
      { cause },
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

export interface GatewayAdminClient {
  issueEnrollmentCode(
    env: GatewayAdminEnv,
  ): Promise<GatewayEnrollmentCode>
  listDevices(env: GatewayAdminEnv): Promise<GatewayDevice[]>
  deploySigningKey(
    env: GatewayAdminEnv,
    signingKey: string,
  ): Promise<void>
}

export function createGatewayAdminClient(
  fetcher: GatewayFetch = fetch,
): GatewayAdminClient {
  return {
    async issueEnrollmentCode(env) {
      const urls = gatewayUrls(env.SMS_GATEWAY_API_URL)
      const response = await gatewayRequest(
        fetcher,
        env,
        urls.mobileCodeUrl,
      )
      const body = await responseJson(response)
      if (
        !isRecord(body) ||
        typeof body.code !== 'string' ||
        !/^\d{6}$/.test(body.code) ||
        typeof body.validUntil !== 'string' ||
        !Number.isFinite(Date.parse(body.validUntil))
      ) {
        throw new GatewayAdminError(
          'SMS Gateway가 올바르지 않은 등록 코드를 보냈습니다.',
        )
      }
      return {
        apiUrl: urls.apiUrl,
        code: body.code,
        validUntil: body.validUntil,
      }
    },

    async listDevices(env) {
      const { managementUrl } = gatewayUrls(
        env.SMS_GATEWAY_API_URL,
      )
      const devicesUrl = new URL(`${managementUrl}/devices`)
      const response = await gatewayRequest(
        fetcher,
        env,
        devicesUrl,
      )
      const body = await responseJson(response)
      if (
        !Array.isArray(body) ||
        body.some(
          (device) =>
            !isRecord(device) ||
            typeof device.id !== 'string' ||
            device.id.length === 0 ||
            typeof device.name !== 'string',
        )
      ) {
        throw new GatewayAdminError(
          'SMS Gateway가 올바르지 않은 기기 목록을 보냈습니다.',
        )
      }
      return body.map((device) => ({
        id: (device as Record<string, unknown>).id as string,
        name: (device as Record<string, unknown>).name as string,
      }))
    },

    async deploySigningKey(env, signingKey) {
      const { managementUrl } = gatewayUrls(
        env.SMS_GATEWAY_API_URL,
      )
      const settingsUrl = new URL(`${managementUrl}/settings`)
      await gatewayRequest(fetcher, env, settingsUrl, {
        method: 'PATCH',
        body: JSON.stringify({
          webhooks: { signing_key: signingKey },
        }),
      })
    },
  }
}

export const gatewayAdminClient = createGatewayAdminClient()
