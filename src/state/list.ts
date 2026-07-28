import type { Scope, Status, StatusFilter } from '../types'
import { patchSelectedConversation } from './conversations'
import type { ActionHandlers, InboxState } from './inbox'

export interface ListState {
  query: string
  filter: StatusFilter
  scope: Scope
  archivedView: boolean
}

export const initialListState: ListState = {
  query: '',
  filter: '전체',
  scope: 'all',
  archivedView: false,
}

export type ListAction =
  | { type: 'setQuery'; value: string }
  | { type: 'setFilter'; value: StatusFilter }
  | { type: 'setScope'; value: Scope }
  | { type: 'toggleArchivedView' }
  | { type: 'setStatus'; value: Status }
  | { type: 'toggleAssignee'; name: string }
  | { type: 'clearAssignees' }
  | { type: 'archive' }
  | { type: 'unarchive' }

export const listHandlers = {
  setQuery: (state, action) => ({ ...state, query: action.value }),

  setFilter: (state, action) => ({ ...state, filter: action.value }),

  setScope: (state, action) => ({ ...state, scope: action.value, menu: null }),

  toggleArchivedView: (state) => {
    const next = !state.archivedView
    const first = state.convs.find((conversation) => conversation.archived === next)
    return {
      ...state,
      archivedView: next,
      menu: null,
      selected: first ? first.id : state.selected,
    }
  },

  setStatus: (state, action) => ({
    ...state,
    menu: null,
    convs: patchSelectedConversation(state, () => ({ status: action.value })),
  }),

  toggleAssignee: (state, action) => ({
    ...state,
    convs: patchSelectedConversation(state, (conversation) => ({
      assignees: conversation.assignees.includes(action.name)
        ? conversation.assignees.filter((assignee) => assignee !== action.name)
        : [...conversation.assignees, action.name],
    })),
  }),

  clearAssignees: (state) => ({
    ...state,
    menu: null,
    convs: patchSelectedConversation(state, () => ({ assignees: [] })),
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
