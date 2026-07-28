import type { EventCatchupResponse } from '../../../shared/wire/event'
import { apiRequest } from '../client'

export function getEvents(
  since: number,
  signal?: AbortSignal,
): Promise<EventCatchupResponse> {
  const query = new URLSearchParams({ since: String(since) })
  return apiRequest(`/api/events?${query}`, { signal })
}
