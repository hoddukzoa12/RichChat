import type { LguFetch } from './protocol'

export interface LguAccessEnv {
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
}

function isConfigured(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export async function fetchLgu(
  env: LguAccessEnv,
  fetcher: LguFetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  const clientId = env.CF_ACCESS_CLIENT_ID
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET

  if (isConfigured(clientId) && isConfigured(clientSecret)) {
    headers.set('CF-Access-Client-Id', clientId)
    headers.set('CF-Access-Client-Secret', clientSecret)
  }

  return await fetcher(input, {
    ...init,
    headers,
  })
}
