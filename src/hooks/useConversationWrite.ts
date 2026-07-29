import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
} from 'react'
import type {
  ConversationListItem,
  ConversationWriteState,
} from '../../shared/wire/conversation'
import { ApiRequestError } from '../api/client'
import {
  conversationVersionConflict,
  patchConversation,
  type ConversationPatch,
} from '../api/endpoints/conversations'
import type { Action } from '../state/inbox'

type ConversationWriteProjection = Pick<
  ConversationWriteState,
  'archived' | 'label' | 'status' | 'version'
>

export type ConversationWriteValues = Omit<
  ConversationPatch,
  'version'
>

function projection(
  conversation: ConversationListItem,
): ConversationWriteProjection {
  return {
    status: conversation.status,
    archived: conversation.archived,
    label: conversation.label,
    version: conversation.version,
  }
}

function failureMessage(error: unknown): string {
  return error instanceof ApiRequestError
    ? error.message
    : '대화 변경을 저장하는 중 알 수 없는 오류가 발생했습니다.'
}

export function useConversationWrite(
  conversation: ConversationListItem,
  dispatch: Dispatch<Action>,
): {
  error: string | null
  pending: boolean
  mutate: (patch: ConversationWriteValues) => Promise<void>
} {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const apply = useCallback(
    (next: ConversationWriteProjection) => {
      dispatch({
        type: 'conversationWriteApplied',
        conversationId: conversation.id,
        conversation: next,
      })
    },
    [conversation.id, dispatch],
  )

  const mutate = useCallback(
    async (patch: ConversationWriteValues) => {
      if (pendingRef.current) return
      pendingRef.current = true
      setPending(true)
      setError(null)

      const previous = projection(conversation)
      apply({ ...previous, ...patch })

      try {
        const response = await patchConversation(conversation.id, {
          ...patch,
          version: conversation.version,
        })
        apply(response.conversation)
      } catch (requestError: unknown) {
        const current = conversationVersionConflict(requestError)
        if (current?.id === conversation.id) {
          apply(current)
          if (mountedRef.current) {
            setError(
              `${failureMessage(requestError)} 현재 서버 값으로 화면을 갱신했습니다.`,
            )
          }
        } else {
          apply(previous)
          if (mountedRef.current) {
            setError(
              `${failureMessage(requestError)} 변경 전 값으로 되돌렸습니다.`,
            )
          }
        }
      } finally {
        pendingRef.current = false
        if (mountedRef.current) setPending(false)
      }
    },
    [apply, conversation],
  )

  return { error, pending, mutate }
}
