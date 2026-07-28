import {
  currentConv,
  initialConversationState,
  type ConversationState,
} from './conversations'
import {
  customerCardHandlers,
  initialCustomerCardState,
  type CustomerCardAction,
  type CustomerCardState,
} from './customerCard'
import { initialListState, listHandlers, type ListAction, type ListState } from './list'
import {
  initialSettingsState,
  settingsHandlers,
  type SettingsAction,
  type SettingsState,
} from './settings'
import {
  initialThreadState,
  threadHandlers,
  type ThreadAction,
  type ThreadState,
} from './thread'
import { initialViewState, viewHandlers, type ViewAction, type ViewState } from './view'

export type ActionHandlers<State, StateAction extends { type: string }> = {
  [Type in StateAction['type']]: (
    state: State,
    action: Extract<StateAction, { type: Type }>,
  ) => State
}

export interface InboxState
  extends ConversationState,
    ViewState,
    ListState,
    ThreadState,
    CustomerCardState,
    SettingsState {}

export type Action =
  | ViewAction
  | ListAction
  | ThreadAction
  | CustomerCardAction
  | SettingsAction

export const initialState: InboxState = {
  ...initialConversationState,
  ...initialViewState,
  ...initialListState,
  ...initialThreadState,
  ...initialCustomerCardState,
  ...initialSettingsState,
}

const actionHandlers = {
  ...viewHandlers,
  ...listHandlers,
  ...threadHandlers,
  ...customerCardHandlers,
  ...settingsHandlers,
} satisfies ActionHandlers<InboxState, Action>

/** 서버 연동 계약으로 승격될 액션 이름의 단일 런타임 목록이다. */
export const ACTION_TYPES = Object.freeze(
  Object.keys(actionHandlers) as Array<Action['type']>,
)

export function reducer(state: InboxState, action: Action): InboxState {
  const handler = actionHandlers[action.type] as (
    current: InboxState,
    nextAction: never,
  ) => InboxState
  return handler(state, action as never)
}

export { currentConv }
export type { AiSettings, OfficeSettings } from './settings'
