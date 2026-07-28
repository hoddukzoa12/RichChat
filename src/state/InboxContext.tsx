import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react'
import type { MeUser } from '../../shared/wire/settings'
import { ApiRequestError } from '../api/client'
import { useAuth } from '../api/AuthGate'
import { getOfficeMembers } from '../api/endpoints'
import { useRealtime } from '../hooks/useRealtime'
import { initialState, reducer, type Action, type InboxState } from './inbox'

interface InboxViewState extends InboxState {
  /** `/api/me` 정본을 기존 소비자에게 노출하는 읽기 전용 뷰다. */
  profile: MeUser
}

interface InboxContextValue {
  state: InboxViewState
  dispatch: React.Dispatch<Action>
}

const InboxContext = createContext<InboxContextValue | null>(null)

export function InboxProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const { me } = useAuth()
  useRealtime(state, dispatch)

  useEffect(() => {
    const controller = new AbortController()
    getOfficeMembers(controller.signal)
      .then(({ members }) => dispatch({ type: 'loadTeam', members }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const message =
          error instanceof ApiRequestError
            ? error.message
            : '직원 목록을 불러오지 못했습니다.'
        dispatch({ type: 'failTeam', message })
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!state.toast) return
    const hide = window.setTimeout(() => dispatch({ type: 'dismissToast' }), 6000)
    return () => window.clearTimeout(hide)
  }, [state.toast])

  const viewState = useMemo(
    () => ({ ...state, profile: me.user }),
    [state, me.user],
  )
  const value = useMemo(() => ({ state: viewState, dispatch }), [viewState])

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}

export function useInbox(): InboxContextValue {
  const ctx = useContext(InboxContext)
  if (!ctx) throw new Error('useInbox must be used inside <InboxProvider>')
  return ctx
}
