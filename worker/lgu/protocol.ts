export const LGU_SUCCESS_CODE = '10000'

export type LguFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export class LguNetworkError extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(`LGU+ 네트워크 요청에 실패했습니다: ${url}`, { cause })
    this.name = 'LguNetworkError'
  }
}

export class LguApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly rawBody: string,
    readonly body: unknown,
  ) {
    super(
      `LGU+ API가 실패를 반환했습니다. code=${code}, status=${status}, body=${rawBody}`,
    )
    this.name = 'LguApiError'
  }
}

function responseCode(body: unknown, status: number): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    (typeof body.code === 'string' || typeof body.code === 'number')
  ) {
    return String(body.code)
  }

  return `HTTP_${status}`
}

export async function fetchLguJson<T>(
  fetcher: LguFetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  let response: Response
  let rawBody: string

  try {
    response = await fetcher(url, init)
    rawBody = await response.text()
  } catch (cause) {
    throw new LguNetworkError(url, cause)
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    throw new LguApiError('INVALID_RESPONSE', response.status, rawBody, null)
  }

  const code = responseCode(body, response.status)
  if (!response.ok || code !== LGU_SUCCESS_CODE) {
    throw new LguApiError(code, response.status, rawBody, body)
  }

  return body as T
}
