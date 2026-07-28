import { DESKTOP_MIN } from '../../shared/breakpoints'
import type { CardTab, MobileView, OpenMenu, Page, Status, Toast } from '../types'
import type { ActionHandlers, InboxState } from './inbox'

export interface ViewState {
  page: Page
  tab: CardTab
  cardOpen: boolean
  mobileView: MobileView
  menu: OpenMenu
  toast: Toast | null
}

export const initialViewState: ViewState = {
  page: 'chat',
  tab: 'info',
  // 고객 카드는 desktop에서 대화 옆에 놓이고 그보다 좁으면 오버레이되므로,
  // 오버레이 구간에서는 닫힌 상태로 시작한다.
  cardOpen: typeof window === 'undefined' || window.innerWidth >= DESKTOP_MIN,
  mobileView: 'list',
  menu: null,
  toast: null,
}

export type ViewAction =
  | { type: 'setPage'; page: Page }
  | { type: 'setTab'; tab: CardTab }
  | { type: 'toggleCard' }
  | { type: 'setMobileView'; view: MobileView }
  | { type: 'setMenu'; value: OpenMenu }
  | { type: 'toastArrive'; toast: Toast }
  | { type: 'openToast' }
  | { type: 'dismissToast' }

const cardOpenAfterMobileView: Record<MobileView, (current: boolean) => boolean> = {
  list: () => false,
  chat: (current) => current,
}

const statusAfterIncoming: Record<Status, Status> = {
  미처리: '미처리',
  처리중: '처리중',
  완료: '처리중',
}

export const viewHandlers = {
  setPage: (state, action) => ({ ...state, page: action.page, menu: null }),

  setTab: (state, action) => ({ ...state, tab: action.tab }),

  toggleCard: (state) => ({ ...state, cardOpen: !state.cardOpen }),

  setMobileView: (state, action) => ({
    ...state,
    mobileView: action.view,
    cardOpen: cardOpenAfterMobileView[action.view](state.cardOpen),
  }),

  setMenu: (state, action) => ({ ...state, menu: action.value }),

  toastArrive: (state, action) => ({
    ...state,
    toast: action.toast,
    convs: state.convs.map((conversation) =>
      conversation.id === action.toast.id
        ? {
            ...conversation,
            messages: [
              ...conversation.messages,
              { dir: 'in' as const, text: action.toast.text, time: '방금' },
            ],
            time: '방금',
            unread: conversation.unread + 1,
            status: statusAfterIncoming[conversation.status],
          }
        : conversation,
    ),
  }),

  openToast: (state) => {
    const toast = state.toast
    if (!toast) return state
    return {
      ...state,
      selected: toast.id,
      toast: null,
      page: 'chat',
      mobileView: 'chat',
      convs: state.convs.map((conversation) =>
        conversation.id === toast.id ? { ...conversation, unread: 0 } : conversation,
      ),
    }
  },

  dismissToast: (state) => ({ ...state, toast: null }),
} satisfies ActionHandlers<InboxState, ViewAction>
