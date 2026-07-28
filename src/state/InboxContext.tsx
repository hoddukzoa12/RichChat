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
import type { ConversationListItem } from '../../shared/wire/conversation'
import type { MeUser } from '../../shared/wire/settings'
import { ApiRequestError } from '../api/client'
import { useAuth } from '../api/AuthGate'
import { getOfficeMembers } from '../api/endpoints'
import { useRealtime } from '../hooks/useRealtime'
import type { Conversation } from '../types'
import { answerFor } from './selectors'
import { currentConv, initialState, reducer, type Action, type InboxState } from './inbox'

interface InboxViewState extends InboxState {
  /** `/api/me` 정본을 기존 소비자에게 노출하는 읽기 전용 뷰다. */
  profile: MeUser
}

interface InboxContextValue {
  state: InboxViewState
  dispatch: React.Dispatch<Action>
  cur: Conversation
  askAi: (question: string) => void
}

const InboxContext = createContext<InboxContextValue | null>(null)

function emptyConversation(
  conversation: ConversationListItem | undefined,
): Conversation {
  const name = conversation?.customer.name ?? ''
  return {
    // F4/F5가 문자열 대화 ID를 쓰는 상세 상태로 교체한다.
    id: 0,
    name,
    company: conversation?.customer.company ?? '',
    orgLine: conversation?.customer.company ?? '',
    initial: name[0] ?? '',
    phone: conversation?.customer.phoneE164 ?? '',
    time: '',
    status: conversation?.status ?? '미처리',
    label: conversation?.label ?? '',
    assignees:
      conversation?.assignees.map((assignee) => assignee.name) ?? [],
    archived: conversation?.archived ?? false,
    unread: conversation?.unreadCount ?? 0,
    folderPath: '',
    folderLinked: false,
    docCount: 0,
    fields: [],
    summary: '',
    todos: [],
    tasks: [],
    docs: [],
    notes: [],
    draft: '',
    // F4가 채운다.
    messages: [],
  }
}

export function InboxProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const { me } = useAuth()
  const aiTimer = useRef<number | undefined>(undefined)
  useRealtime(state, dispatch)

  // F4/F5가 상세 읽기 모델로 교체한다.
  const cur = useMemo(
    () => emptyConversation(currentConv(state)),
    [state.convs, state.selected],
  )

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
    aiTimer.current = window.setTimeout(
      () => dispatch({ type: 'aiReply', id: String(conv.id), text }),
      1100,
    )
  }, [])

  useEffect(() => () => window.clearTimeout(aiTimer.current), [])

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
  const value = useMemo(
    () => ({ state: viewState, dispatch, cur, askAi }),
    [viewState, cur, askAi],
  )

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}

export function useInbox(): InboxContextValue {
  const ctx = useContext(InboxContext)
  if (!ctx) throw new Error('useInbox must be used inside <InboxProvider>')
  return ctx
}
