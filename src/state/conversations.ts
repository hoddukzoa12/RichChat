import { CONVERSATIONS } from '../data/seed'
import type { Conversation } from '../types'

/**
 * 목록·스레드·고객 카드가 함께 갱신하는 대화 aggregate다.
 * 각 관심사에 복제하지 않고 선택된 대화와 원본 컬렉션을 한 곳에서 관리한다.
 */
export interface ConversationState {
  convs: Conversation[]
  selected: number
}

export const initialConversationState: ConversationState = {
  convs: CONVERSATIONS,
  selected: 1,
}

export function currentConv(state: ConversationState): Conversation {
  return state.convs.find((conversation) => conversation.id === state.selected) ?? state.convs[0]
}

/** 선택된 대화에만 `update`를 적용한다. */
export function patchSelectedConversation(
  state: ConversationState,
  update: (conversation: Conversation) => Partial<Conversation>,
): Conversation[] {
  return state.convs.map((conversation) =>
    conversation.id === state.selected
      ? { ...conversation, ...update(conversation) }
      : conversation,
  )
}
