import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import type { Conversation } from '../types'
import { INCOMING } from '../data/seed'
import { answerFor } from './selectors'
import { currentConv, initialState, reducer, type Action, type InboxState } from './inbox'

interface InboxContextValue {
  state: InboxState
  dispatch: React.Dispatch<Action>
  cur: Conversation
  askAi: (question: string) => void
}

const InboxContext = createContext<InboxContextValue | null>(null)

export function InboxProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const aiTimer = useRef<number | undefined>(undefined)

  const cur = currentConv(state)

  // `askAi` needs the conversation as it is *now*, so the answer is resolved up
  // front and only its delivery is delayed.
  const curRef = useRef(cur)
  curRef.current = cur

  const askAi = useCallback((question: string) => {
    const q = question.trim()
    if (!q) return
    const conv = curRef.current
    const text = answerFor(conv, q)
    dispatch({ type: 'askAi', question: q })
    window.clearTimeout(aiTimer.current)
    aiTimer.current = window.setTimeout(() => dispatch({ type: 'aiReply', id: conv.id, text }), 1100)
  }, [])

  useEffect(() => () => window.clearTimeout(aiTimer.current), [])

  // Demo: a new message lands 3.5s after mount and toasts for 6s.
  useEffect(() => {
    const arrive = window.setTimeout(() => dispatch({ type: 'toastArrive', toast: INCOMING }), 3500)
    return () => window.clearTimeout(arrive)
  }, [])

  useEffect(() => {
    if (!state.toast) return
    const hide = window.setTimeout(() => dispatch({ type: 'dismissToast' }), 6000)
    return () => window.clearTimeout(hide)
  }, [state.toast])

  const value = useMemo(() => ({ state, dispatch, cur, askAi }), [state, cur, askAi])

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}

export function useInbox(): InboxContextValue {
  const ctx = useContext(InboxContext)
  if (!ctx) throw new Error('useInbox must be used inside <InboxProvider>')
  return ctx
}
