import type {
  ConversationArchiveFilter,
  ConversationListItem,
  ConversationListFacets,
  ConversationListResponse,
  ConversationScope,
  ConversationStatusFilter,
  ConversationWriteState,
} from '../../shared/wire/conversation'
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
  | {
      type: 'conversationWriteApplied'
      conversationId: string
      conversation: Pick<
        ConversationWriteState,
        'archived' | 'label' | 'status' | 'version'
      >
    }
  | {
      type: 'conversationStarted'
      conversation: ConversationListItem
    }

const ARCHIVE_FILTER: Record<
  `${boolean}`,
  ConversationArchiveFilter
> = {
  false: 'active',
  true: 'archived',
}

function adjustedCount(count: number, delta: number): number {
  return Math.max(0, count + delta)
}

function applyStatusFacetChange(
  state: InboxState,
  previous: ConversationListItem,
  next: ConversationListItem,
): ConversationListFacets['status'] {
  const status = { ...state.facets.status }
  const previousIncluded =
    previous.archived === state.archivedView
  const nextIncluded = next.archived === state.archivedView

  if (previousIncluded) {
    status[previous.status] = adjustedCount(
      status[previous.status],
      -1,
    )
    status.전체 = adjustedCount(status.전체, -1)
  }
  if (nextIncluded) {
    status[next.status] = adjustedCount(status[next.status], 1)
    status.전체 = adjustedCount(status.전체, 1)
  }

  return status
}

function matchesStatusFilter(
  status: ConversationListItem['status'],
  filter: ConversationStatusFilter,
): boolean {
  return filter === '전체' || status === filter
}

function applyArchiveFacetChange(
  state: InboxState,
  previous: ConversationListItem,
  next: ConversationListItem,
): ConversationListFacets['archive'] {
  const archive = { ...state.facets.archive }
  const previousIncluded = matchesStatusFilter(
    previous.status,
    state.filter,
  )
  const nextIncluded = matchesStatusFilter(next.status, state.filter)
  const previousArchive = ARCHIVE_FILTER[`${previous.archived}`]
  const nextArchive = ARCHIVE_FILTER[`${next.archived}`]

  if (previousIncluded) {
    archive[previousArchive] = adjustedCount(
      archive[previousArchive],
      -1,
    )
  }
  if (nextIncluded) {
    archive[nextArchive] = adjustedCount(archive[nextArchive], 1)
  }

  return archive
}

function applyConversationWrite(
  state: InboxState,
  conversationId: string,
  write: Pick<
    ConversationWriteState,
    'archived' | 'label' | 'status' | 'version'
  >,
): InboxState {
  const previous = state.convs.find(
    (conversation) => conversation.id === conversationId,
  )
  if (!previous) return state

  const next = { ...previous, ...write }
  return {
    ...state,
    convs: state.convs.map((conversation) =>
      conversation.id === conversationId ? next : conversation,
    ),
    facets: {
      ...state.facets,
      status: applyStatusFacetChange(state, previous, next),
      archive: applyArchiveFacetChange(state, previous, next),
    },
  }
}

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

  conversationWriteApplied: (state, action) =>
    applyConversationWrite(
      state,
      action.conversationId,
      action.conversation,
    ),

  conversationStarted: (state, action) => ({
    ...state,
    convs: [
      action.conversation,
      ...state.convs.filter(
        ({ id }) => id !== action.conversation.id,
      ),
    ],
    selected: action.conversation.id,
    query: '',
    filter: '전체',
    scope: 'all',
    archivedView: action.conversation.archived,
    mobileView: 'chat',
    menu: null,
  }),
} satisfies ActionHandlers<InboxState, ListAction>
