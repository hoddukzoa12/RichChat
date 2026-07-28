import type { AiChatMessage } from '../types'
import { patchSelectedConversation } from './conversations'
import {
  initialCustomerCardDataState,
  reduceCustomerCardData,
  type CustomerCardDataAction,
  type CustomerCardDataState,
} from './customerCardModel'
import type { ActionHandlers, InboxState } from './inbox'

export interface CustomerCardState extends CustomerCardDataState {
  aiChats: Record<string, AiChatMessage[]>
  aiDraft: string
  aiLoading: boolean
}

export const initialCustomerCardState: CustomerCardState = {
  ...initialCustomerCardDataState,
  aiChats: {},
  aiDraft: '',
  aiLoading: false,
}

export type CustomerCardAction =
  | { type: 'cardData'; action: CustomerCardDataAction }
  | { type: 'toggleTodo'; index: number }
  | { type: 'linkFolder' }
  | { type: 'unlinkFolder' }
  | { type: 'setAiDraft'; value: string }
  | { type: 'askAi'; question: string }
  | { type: 'aiReply'; id: string; text: string }

export const customerCardHandlers = {
  cardData: (state, action) => {
    const reduced = reduceCustomerCardData(state, action.action) as InboxState
    if (action.action.type !== 'customerSaved') return reduced
    if (reduced.selected !== action.action.conversationId) return reduced

    const customer = action.action.customer
    return {
      ...reduced,
      convs: patchSelectedConversation(reduced, (conversation) => ({
        customer: {
          ...conversation.customer,
          name: customer.name,
          company: customer.company,
          phoneE164: customer.phoneE164,
        },
      })),
    }
  },

  // AI·폴더 탭은 각 소유 슬라이스가 서버 모델로 교체한다.
  toggleTodo: (state, action) => {
    void action.index
    return state
  },

  linkFolder: (state) => state,

  unlinkFolder: (state) => state,

  setAiDraft: (state, action) => ({ ...state, aiDraft: action.value }),

  askAi: (state, action) => {
    const question = action.question.trim()
    if (!question || state.selected === null) return state
    const id = state.selected
    return {
      ...state,
      aiDraft: '',
      aiLoading: true,
      aiChats: {
        ...state.aiChats,
        [id]: [...(state.aiChats[id] ?? []), { role: 'user', text: question }],
      },
    }
  },

  aiReply: (state, action) => ({
    ...state,
    aiLoading: false,
    aiChats: {
      ...state.aiChats,
      [action.id]: [
        ...(state.aiChats[action.id] ?? []),
        { role: 'ai', text: action.text },
      ],
    },
  }),
} satisfies ActionHandlers<InboxState, CustomerCardAction>
