import { apiJsonRequest } from './request'

// 목록 계약은 절대 커서를 노출하지 않으므로 서버가 현재 수신 수로 clamp한다.
const READ_ALL_INBOUND_COUNT = Number.MAX_SAFE_INTEGER

export function markConversationRead(
  conversationId: string,
  signal?: AbortSignal,
): Promise<void> {
  return apiJsonRequest(
    `/api/conversations/${conversationId}/read`,
    'POST',
    { readInboundCount: READ_ALL_INBOUND_COUNT },
    signal,
  )
}
