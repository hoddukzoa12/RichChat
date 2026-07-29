import type {
  ConversationListParams,
  ConversationListResponse,
  ConversationWriteResponse,
  ConversationWriteState,
} from '../../../shared/wire/conversation'
import { STATUSES, type Status } from '../../../shared/domain'
import { ApiRequestError, apiRequest } from '../client'
import { jsonMutation } from './jsonMutation'

export interface ConversationPatch {
  status?: Status
  archived?: boolean
  label?: string
  version: number
}

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

export function patchConversation(
  conversationId: string,
  patch: ConversationPatch,
  signal?: AbortSignal,
): Promise<ConversationWriteResponse> {
  return jsonMutation(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    'PATCH',
    { ...patch },
    signal,
  )
}

function isConversationWriteState(
  value: unknown,
): value is ConversationWriteState {
  if (typeof value !== 'object' || value === null) return false
  const conversation = value as Record<string, unknown>
  return (
    typeof conversation.id === 'string' &&
    typeof conversation.status === 'string' &&
    STATUSES.includes(conversation.status as Status) &&
    typeof conversation.label === 'string' &&
    typeof conversation.archived === 'boolean' &&
    Number.isSafeInteger(conversation.version) &&
    Number.isSafeInteger(conversation.updatedAt)
  )
}

/** 409 응답의 서버 정본을 화면 재동기화에 쓸 수 있을 때만 반환한다. */
export function conversationVersionConflict(
  error: unknown,
): ConversationWriteState | null {
  if (
    !(error instanceof ApiRequestError) ||
    error.status !== 409 ||
    error.code !== 'CONFLICT_VERSION' ||
    typeof error.detail !== 'object' ||
    error.detail === null ||
    !('conversation' in error.detail)
  ) {
    return null
  }

  const conversation = error.detail.conversation
  return isConversationWriteState(conversation) ? conversation : null
}
