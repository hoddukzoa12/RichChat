import type { ActionHandlers, InboxState } from './inbox'

export interface ThreadState {
  draft: string
}

export const initialThreadState: ThreadState = {
  draft: '',
}

export type ThreadAction =
  | { type: 'select'; id: string }
  | { type: 'setDraft'; value: string }
  | { type: 'send'; now: number }
  | { type: 'draftReply' }

export const threadHandlers = {
  select: (state, action) => ({
    ...state,
    selected: action.id,
    menu: null,
    draft: '',
    mobileView: 'chat',
    editDraft: null,
    taskEdit: null,
    addingTask: false,
    noteEdit: null,
    addingNote: false,
  }),

  setDraft: (state, action) => ({ ...state, draft: action.value }),

  send: (state, action) => {
    const text = state.draft.trim()
    if (!text) return state
    // F4가 채운다.
    void action.now
    return {
      ...state,
      draft: '',
    }
  },

  // F4가 채운다.
  draftReply: (state) => ({ ...state, draft: '확인 후 회신드리겠습니다.' }),
} satisfies ActionHandlers<InboxState, ThreadAction>
