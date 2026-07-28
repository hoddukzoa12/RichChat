import { apiRequest, type MutationMethod } from '../client'

export function jsonMutation<
  Result,
  Body extends Record<string, unknown>,
>(
  path: string,
  method: MutationMethod,
  body: Body,
  signal?: AbortSignal,
): Promise<Result> {
  return apiRequest(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}
