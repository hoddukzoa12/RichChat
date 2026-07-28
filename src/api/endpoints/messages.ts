import type {
  MessagePageResponse,
} from '../../../shared/wire/message'
import type {
  SendMessageRequest,
  SendMessageResponse,
} from '../../../shared/wire/message-send'
import { ApiRequestError, apiRequest } from '../client'

export interface MessagePageOptions {
  before?: string
  signal?: AbortSignal
}

function conversationMessagesPath(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/messages`
}

/** 서버가 오름차순으로 준 메시지 페이지를 그대로 받는다. */
export function getConversationMessages(
  conversationId: string,
  options: MessagePageOptions = {},
): Promise<MessagePageResponse> {
  const search = new URLSearchParams()
  if (options.before) search.set('before', options.before)
  const query = search.size > 0 ? `?${search.toString()}` : ''

  return apiRequest(`${conversationMessagesPath(conversationId)}${query}`, {
    signal: options.signal,
  })
}

/**
 * 재시도할 때도 호출자가 만든 clientKey를 그대로 보낸다.
 * 새 키를 자동 생성하는 범용 mutation helper를 이 경로에 쓰면 중복 발송된다.
 */
export async function sendConversationMessage(
  conversationId: string,
  request: SendMessageRequest,
  signal?: AbortSignal,
): Promise<SendMessageResponse> {
  const response = await apiRequest<SendMessageResponse>(
    conversationMessagesPath(conversationId),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    },
  )

  if (response.clientKey !== request.clientKey) {
    throw new ApiRequestError(
      'server',
      '서버가 발송 요청의 식별 키를 돌려주지 않았습니다.',
    )
  }

  return response
}
