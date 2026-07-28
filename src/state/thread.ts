import { ME } from '../data/seed'
import type { Status } from '../types'
import { currentConv, patchSelectedConversation } from './conversations'
import type { ActionHandlers, InboxState } from './inbox'

export interface ThreadState {
  draft: string
}

export const initialThreadState: ThreadState = {
  draft: '',
}

export type ThreadAction =
  | { type: 'select'; id: number }
  | { type: 'setDraft'; value: string }
  | { type: 'send'; now: number }
  | { type: 'draftReply' }

const statusAfterSend: Record<Status, Status> = {
  미처리: '처리중',
  처리중: '처리중',
  완료: '완료',
}

function clockLabel(now: Date): string {
  const hours = now.getHours()
  return `${hours < 12 ? '오전' : '오후'} ${hours % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')}`
}

function outboundStamp(now: Date): string {
  return `SMS · ${clockLabel(now)}`
}

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
    convs: state.convs.map((conversation) =>
      conversation.id === action.id ? { ...conversation, unread: 0 } : conversation,
    ),
  }),

  setDraft: (state, action) => ({ ...state, draft: action.value }),

  send: (state, action) => {
    const text = state.draft.trim()
    if (!text) return state
    const now = new Date(action.now)
    return {
      ...state,
      draft: '',
      convs: patchSelectedConversation(state, (conversation) => ({
        messages: [
          ...conversation.messages,
          { dir: 'out' as const, text, time: outboundStamp(now) },
        ],
        time: '방금',
        status: statusAfterSend[conversation.status],
        assignees: conversation.assignees.length ? conversation.assignees : [ME],
      })),
    }
  },

  draftReply: (state) => ({
    ...state,
    draft: currentConv(state).draft || '확인 후 회신드리겠습니다.',
  }),
} satisfies ActionHandlers<InboxState, ThreadAction>
