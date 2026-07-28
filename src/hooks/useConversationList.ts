import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
} from 'react'
import {
  type ConversationListParams,
} from '../../shared/wire/conversation'
import { getConversations } from '../api/endpoints/conversations'
import type { Action, InboxState } from '../state/inbox'
import { conversationListParams } from '../state/selectors'

const SEARCH_DEBOUNCE_MS = 300

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : '대화 목록을 불러오는 중 알 수 없는 오류가 발생했습니다.'
}

export function useConversationList(
  state: InboxState,
  dispatch: Dispatch<Action>,
): {
  loadMore: () => void
  retry: () => void
} {
  const [debouncedQuery, setDebouncedQuery] = useState(() =>
    state.query.trim(),
  )
  const [retryAttempt, setRetryAttempt] = useState(0)
  const requestSequence = useRef(0)
  const paginationController = useRef<AbortController | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQuery(state.query.trim()),
      SEARCH_DEBOUNCE_MS,
    )
    return () => window.clearTimeout(timer)
  }, [state.query])

  useEffect(() => {
    const controller = new AbortController()
    paginationController.current?.abort()
    paginationController.current = null
    const requestId = ++requestSequence.current
    const params = conversationListParams(state, debouncedQuery)

    dispatch({
      type: 'conversationListLoadStarted',
      requestId,
      append: false,
    })
    getConversations(params, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        dispatch({
          type: 'conversationListLoadSucceeded',
          requestId,
          append: false,
          response,
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        dispatch({
          type: 'conversationListLoadFailed',
          requestId,
          append: false,
          message: errorMessage(error),
        })
      })

    return () => controller.abort()
  }, [
    debouncedQuery,
    dispatch,
    retryAttempt,
    state.archivedView,
    state.filter,
    state.scope,
  ])

  useEffect(
    () => () => {
      paginationController.current?.abort()
    },
    [],
  )

  const loadMore = useCallback(() => {
    if (
      state.loadingMore ||
      state.listLoadStatus !== 'loaded' ||
      !state.nextCursor ||
      (paginationController.current !== null &&
        !paginationController.current.signal.aborted)
    ) {
      return
    }

    const controller = new AbortController()
    paginationController.current?.abort()
    paginationController.current = controller
    const requestId = ++requestSequence.current
    const params: ConversationListParams = {
      ...conversationListParams(state, debouncedQuery),
      cursor: state.nextCursor,
    }

    dispatch({
      type: 'conversationListLoadStarted',
      requestId,
      append: true,
    })
    getConversations(params, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        dispatch({
          type: 'conversationListLoadSucceeded',
          requestId,
          append: true,
          response,
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        dispatch({
          type: 'conversationListLoadFailed',
          requestId,
          append: true,
          message: errorMessage(error),
        })
      })
      .finally(() => {
        if (paginationController.current === controller) {
          paginationController.current = null
        }
      })
  }, [
    debouncedQuery,
    dispatch,
    state.archivedView,
    state.filter,
    state.listLoadStatus,
    state.loadingMore,
    state.nextCursor,
    state.scope,
  ])

  return {
    loadMore,
    retry: () => setRetryAttempt((attempt) => attempt + 1),
  }
}
