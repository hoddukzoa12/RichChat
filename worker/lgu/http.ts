import { fetchLguJson, type LguFetch } from './protocol'
import {
  getLguAccessToken,
  type LguTokenEnv,
  type LguTokenProvider,
} from './token'

export type LguApiService = 'send' | 'content'

export interface LguHttpEnv extends LguTokenEnv {
  LGU_SEND_HOST: string
  LGU_CONTENT_HOST: string
}

const HOST_BINDING: Record<
  LguApiService,
  'LGU_SEND_HOST' | 'LGU_CONTENT_HOST'
> = {
  send: 'LGU_SEND_HOST',
  content: 'LGU_CONTENT_HOST',
}

interface LguHttpOptions {
  fetch?: LguFetch
  tokenProvider?: LguTokenProvider
}

export function createLguHttpClient(options: LguHttpOptions = {}) {
  const fetcher = options.fetch ?? fetch
  const tokenProvider = options.tokenProvider ?? getLguAccessToken

  return async function requestLgu<T>(
    env: LguHttpEnv,
    officeId: string,
    service: LguApiService,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const accessToken = await tokenProvider(env, officeId)
    const binding = HOST_BINDING[service]
    const host = env[binding]
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${accessToken}`)

    return await fetchLguJson<T>(
      fetcher,
      new URL(path, `https://${host}`).toString(),
      {
        ...init,
        headers,
      },
    )
  }
}

export const requestLgu = createLguHttpClient()

export {
  LguApiError,
  LguNetworkError,
} from './protocol'
