import type {
  ConversationListFacets,
  ConversationListResponse,
  ConversationScope,
  ConversationStatusFilter,
} from '../../shared/wire/conversation'
import type { Status } from '../types'
import { patchSelectedConversation } from './conversations'
import type { ActionHandlers, InboxState } from './inbox'

export type ConversationListLoadStatus =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'failed'

export interface ListState {
  query: string
  filter: ConversationStatusFilter
  scope: ConversationScope
  archivedView: boolean
  facets: ConversationListFacets
  nextCursor: string | null
  listLoadStatus: ConversationListLoadStatus
  loadingMore: boolean
  listError: string | null
  listRequestId: number
}

function emptyFacets(): ConversationListFacets {
  return {
    status: { 전체: 0, 미처리: 0, 처리중: 0, 완료: 0 },
    scope: { all: 0, mine: 0, none: 0 },
    archive: { active: 0, archived: 0 },
  }
}

export const initialListState: ListState = {
  query: '',
  filter: '전체',
  scope: 'all',
  archivedView: false,
  facets: emptyFacets(),
  nextCursor: null,
  listLoadStatus: 'idle',
  loadingMore: false,
  listError: null,
  listRequestId: 0,
}

export type ListAction =
  | { type: 'setQuery'; value: string }
  | { type: 'setFilter'; value: ConversationStatusFilter }
  | { type: 'setScope'; value: ConversationScope }
  | { type: 'toggleArchivedView' }
  | {
      type: 'conversationListLoadStarted'
      requestId: number
      append: boolean
    }
  | {
      type: 'conversationListLoadSucceeded'
      requestId: number
      append: boolean
      response: ConversationListResponse
    }
  | {
      type: 'conversationListLoadFailed'
      requestId: number
      append: boolean
      message: string
    }
  | { type: 'setStatus'; value: Status }
  | { type: 'archive' }
  | { type: 'unarchive' }

function mergeConversationPage(
  current: InboxState['convs'],
  response: ConversationListResponse,
): InboxState['convs'] {
  const conversations = new Map(
    current.map((conversation) => [conversation.id, conversation]),
  )
  for (const conversation of response.conversations) {
    conversations.set(conversation.id, conversation)
  }
  return [...conversations.values()]
}

export const listHandlers = {
  setQuery: (state, action) => ({ ...state, query: action.value }),

  setFilter: (state, action) => ({ ...state, filter: action.value }),

  setScope: (state, action) => ({ ...state, scope: action.value, menu: null }),

  toggleArchivedView: (state) => {
    return {
      ...state,
      archivedView: !state.archivedView,
      menu: null,
    }
  },

  conversationListLoadStarted: (state, action) =>
    action.append
      ? {
          ...state,
          listRequestId: action.requestId,
          loadingMore: true,
          listError: null,
        }
      : {
          ...state,
          convs: [],
          facets: emptyFacets(),
          nextCursor: null,
          listLoadStatus: 'loading' as const,
          loadingMore: false,
          listError: null,
          listRequestId: action.requestId,
        },

  conversationListLoadSucceeded: (state, action) => {
    if (action.requestId !== state.listRequestId) return state
    const convs = action.append
      ? mergeConversationPage(state.convs, action.response)
      : action.response.conversations
    const selected =
      state.selected &&
      convs.some((conversation) => conversation.id === state.selected)
        ? state.selected
        : (convs[0]?.id ?? null)

    return {
      ...state,
      convs,
      selected,
      facets: action.response.facets,
      nextCursor: action.response.nextCursor,
      listLoadStatus: 'loaded' as const,
      loadingMore: false,
      listError: null,
    }
  },

  conversationListLoadFailed: (state, action) => {
    if (action.requestId !== state.listRequestId) return state
    return {
      ...state,
      listLoadStatus: action.append
        ? state.listLoadStatus
        : ('failed' as const),
      loadingMore: false,
      listError: action.message,
    }
  },

  setStatus: (state, action) => ({
    ...state,
    menu: null,
    convs: patchSelectedConversation(state, () => ({ status: action.value })),
  }),

  archive: (state) => ({
    ...state,
    convs: patchSelectedConversation(state, () => ({ archived: true, status: '완료' })),
  }),

  unarchive: (state) => ({
    ...state,
    convs: patchSelectedConversation(state, () => ({ archived: false, status: '처리중' })),
  }),
} satisfies ActionHandlers<InboxState, ListAction>
