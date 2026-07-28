import type {
  ConversationListParams,
  ConversationListResponse,
} from '../../../shared/wire/conversation'
import { apiRequest } from '../client'

export function getConversations(
  params: ConversationListParams,
  signal?: AbortSignal,
): Promise<ConversationListResponse> {
  const query = new URLSearchParams()
  if (params.archived !== undefined) {
    query.set('archived', String(params.archived))
  }
  if (params.scope !== undefined) query.set('scope', params.scope)
  if (params.status !== undefined) query.set('status', params.status)
  if (params.q !== undefined) query.set('q', params.q)
  if (params.cursor !== undefined) query.set('cursor', params.cursor)
  if (params.limit !== undefined) query.set('limit', String(params.limit))

  const suffix = query.size > 0 ? `?${query}` : ''
  return apiRequest(`/api/conversations${suffix}`, { signal })
}
