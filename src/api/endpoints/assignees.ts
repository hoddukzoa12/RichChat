import { apiRequest } from '../client'

function assigneePath(
  conversationId: string,
  userId: string,
): string {
  return `/api/conversations/${encodeURIComponent(
    conversationId,
  )}/assignees/${encodeURIComponent(userId)}`
}

/** 기존 배정 상태와 무관하게 이 사용자 한 명만 명시적으로 배정한다. */
export function assignConversation(
  conversationId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  return apiRequest(assigneePath(conversationId, userId), {
    method: 'POST',
    signal,
  })
}

/** 기존 배정 상태와 무관하게 이 사용자 한 명만 명시적으로 해제한다. */
export function unassignConversation(
  conversationId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  return apiRequest(assigneePath(conversationId, userId), {
    method: 'DELETE',
    signal,
  })
}
