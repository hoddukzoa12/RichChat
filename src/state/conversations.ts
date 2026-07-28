import type { ConversationListItem } from '../../shared/wire/conversation'

export interface ConversationState {
  convs: ConversationListItem[]
  selected: string | null
}

export const initialConversationState: ConversationState = {
  convs: [],
  selected: null,
}

export function currentConv(
  state: ConversationState,
): ConversationListItem | undefined {
  return (
    state.convs.find((conversation) => conversation.id === state.selected) ??
    state.convs[0]
  )
}

/** 선택된 대화에만 `update`를 적용한다. */
export function patchSelectedConversation(
  state: ConversationState,
  update: (
    conversation: ConversationListItem,
  ) => Partial<ConversationListItem>,
): ConversationListItem[] {
  return state.convs.map((conversation) =>
    conversation.id === state.selected
      ? { ...conversation, ...update(conversation) }
      : conversation,
  )
}
