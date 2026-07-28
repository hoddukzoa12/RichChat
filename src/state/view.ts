import { DESKTOP_MIN } from '../../shared/breakpoints'
import type { CardTab, MobileView, OpenMenu, Page, Toast } from '../types'
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

  // F7가 채운다.
  toastArrive: (state, action) => ({ ...state, toast: action.toast }),

  openToast: (state) => {
    const toast = state.toast
    if (!toast) return state
    return {
      ...state,
      toast: null,
      page: 'chat',
      mobileView: 'chat',
    }
  },

  dismissToast: (state) => ({ ...state, toast: null }),
} satisfies ActionHandlers<InboxState, ViewAction>
