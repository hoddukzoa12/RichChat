import { apiRequest, type MutationMethod } from '../client'

const JSON_HEADERS = { 'content-type': 'application/json' }

export function apiJsonRequest<Result>(
  path: string,
  method: MutationMethod,
  body: unknown,
  signal?: AbortSignal,
): Promise<Result> {
  return apiRequest(path, {
    method,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    signal,
  })
}
