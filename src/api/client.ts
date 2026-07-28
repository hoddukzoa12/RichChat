import type { ApiError } from '../../shared/wire/error'

export type ApiFailureKind = 'network' | 'server'

export class ApiRequestError extends Error {
  readonly kind: ApiFailureKind
  readonly status?: number
  readonly code?: string
  readonly detail?: unknown

  constructor(
    kind: ApiFailureKind,
    message: string,
    options: {
      status?: number
      code?: string
      detail?: unknown
      cause?: unknown
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'ApiRequestError'
    this.kind = kind
    this.status = options.status
    this.code = options.code
    this.detail = options.detail
  }
}

const unauthorizedListeners = new Set<() => void>()

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener()
}

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = value.error
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  )
}

async function serverError(response: Response): Promise<ApiRequestError> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }

  const message = isApiError(payload)
    ? payload.error.message
    : `서버 요청에 실패했습니다. (${response.status})`
  const detail = isApiError(payload) ? payload.error.detail : undefined
  return new ApiRequestError('server', message, {
    status: response.status,
    code: isApiError(payload) ? payload.error.code : undefined,
    detail,
  })
}

export async function apiRequest<Result>(
  path: string,
  init: RequestInit = {},
): Promise<Result> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiRequestError(
      'network',
      '서버에 연결할 수 없습니다. 네트워크 연결을 확인해 주세요.',
      { cause },
    )
  }

  if (!response.ok) {
    const failure = await serverError(response)
    if (response.status === 401) notifyUnauthorized()
    throw failure
  }

  if (response.status === 204) return undefined as Result

  try {
    return (await response.json()) as Result
  } catch (cause) {
    throw new ApiRequestError(
      'server',
      '서버가 올바르지 않은 응답을 보냈습니다.',
      { status: response.status, cause },
    )
  }
}

export type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface MutationOptions<Body extends Record<string, unknown>>
  extends Omit<RequestInit, 'body' | 'method'> {
  method: MutationMethod
  body: Body
}

export type MutationResult<Result extends Record<string, unknown>> = Result & {
  clientKey: string
}

export async function apiMutation<
  Result extends Record<string, unknown>,
  Body extends Record<string, unknown>,
>(
  path: string,
  options: MutationOptions<Body>,
): Promise<MutationResult<Result>> {
  const clientKey = crypto.randomUUID()
  const headers = new Headers(options.headers)
  headers.set('content-type', 'application/json')

  const response = await apiRequest<MutationResult<Result>>(path, {
    ...options,
    headers,
    body: JSON.stringify({ ...options.body, clientKey }),
  })

  if (response.clientKey !== clientKey) {
    throw new ApiRequestError(
      'server',
      '서버가 변경 요청의 식별 키를 돌려주지 않았습니다.',
    )
  }

  return response
}
