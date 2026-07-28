import { useCallback, useEffect, useState } from 'react'
import type { ConversationListItem } from '../../shared/wire/conversation'
import type { OfficeMember } from '../../shared/wire/office'
import { initialOf } from '../../shared/text'
import { useAuth } from '../api/AuthGate'
import { ApiRequestError } from '../api/client'
import {
  assignConversation,
  unassignConversation,
} from '../api/endpoints/assignees'
import {
  getConversationMessages,
  sendConversationMessage,
} from '../api/endpoints/messages'
import { useInbox } from '../state/InboxContext'
import { currentConv } from '../state/conversations'
import { assigneeLabel } from '../state/selectors'
import {
  threadFor,
  type ThreadFailure,
} from '../state/thread'
import { STATUSES, STATUS_DOT, STATUS_TEXT } from '../theme'
import { Avatar, MenuItem, Popover } from './ui'
import type { Breakpoint } from '../hooks/useBreakpoint'
import {
  MessageComposer,
  MessageThread,
} from './ThreadPanel'

type AssigneeIntent = 'assign' | 'unassign'

const ASSIGNEE_REQUEST: Record<
  AssigneeIntent,
  (
    conversationId: string,
    userId: string,
  ) => Promise<void>
> = {
  assign: assignConversation,
  unassign: unassignConversation,
}

function AssigneePicker({
  conversation,
  members,
  teamLoading,
  teamError,
}: {
  conversation: ConversationListItem
  members: OfficeMember[]
  teamLoading: boolean
  teamError: string | null
}) {
  const { state, dispatch } = useInbox()
  const [pending, setPending] = useState<
    Record<string, AssigneeIntent | undefined>
  >({})
  const [mutationError, setMutationError] = useState<string | null>(
    null,
  )
  const label = assigneeLabel(conversation)

  const mutate = async (
    intent: AssigneeIntent,
    member: OfficeMember,
  ) => {
    setPending((current) => ({
      ...current,
      [member.id]: intent,
    }))
    setMutationError(null)
    try {
      await ASSIGNEE_REQUEST[intent](conversation.id, member.id)
      const success: Record<AssigneeIntent, () => void> = {
        assign: () =>
          dispatch({
            type: 'assigneeAssigned',
            conversationId: conversation.id,
            assignee: { id: member.id, name: member.name },
          }),
        unassign: () =>
          dispatch({
            type: 'assigneeUnassigned',
            conversationId: conversation.id,
            userId: member.id,
          }),
      }
      success[intent]()
    } catch (error: unknown) {
      setMutationError(failureFrom(error).message)
    } finally {
      setPending((current) => ({
        ...current,
        [member.id]: undefined,
      }))
    }
  }

  return (
    <div className="relative flex-none">
      {label ? (
        <button
          type="button"
          className="h-[34px] px-2.5 border border-line-strong rounded-[9px] flex items-center gap-1.5 text-[13.5px] font-semibold text-ink-700 hover:border-brand whitespace-nowrap"
          onClick={() =>
            dispatch({
              type: 'setMenu',
              value: state.menu === 'assign' ? null : 'assign',
            })
          }
        >
          <Avatar
            initial={initialOf(conversation.assignees[0].name)}
            className="w-[18px] h-[18px] text-[10px]"
          />
          {label}
          <span className="text-[9px] text-ink-400">▼</span>
        </button>
      ) : (
        <button
          type="button"
          className="h-[34px] px-3 border border-dashed border-ink-300 rounded-[9px] flex items-center gap-1.5 text-[13.5px] font-medium text-ink-600 hover:border-brand hover:text-brand whitespace-nowrap"
          onClick={() =>
            dispatch({
              type: 'setMenu',
              value: state.menu === 'assign' ? null : 'assign',
            })
          }
        >
          ＋ 담당자 배정
        </button>
      )}
      <Popover
        open={state.menu === 'assign'}
        onClose={() => dispatch({ type: 'setMenu', value: null })}
        className="top-10 left-0 w-[220px] rounded-[11px] p-1.5"
      >
        <div className="px-2 pt-1.5 pb-[7px] text-[11.5px] font-bold text-ink-400 tracking-[0.3px]">
          담당자 배정 · 여러 명 선택 가능
        </div>

        {teamLoading && (
          <div className="px-2.5 py-4 text-center text-xs text-ink-400">
            팀 목록을 불러오는 중입니다.
          </div>
        )}
        {!teamLoading && teamError && (
          <div
            role="alert"
            className="px-2.5 py-3 text-xs text-open-fg"
          >
            {teamError}
          </div>
        )}
        {!teamLoading && !teamError && members.length === 0 && (
          <div className="px-2.5 py-4 text-center text-xs text-ink-400">
            배정할 팀원이 없습니다.
          </div>
        )}
        {!teamLoading &&
          !teamError &&
          members.map((member) => {
            const assigned = conversation.assignees.some(
              (assignee) => assignee.id === member.id,
            )
            const busy = pending[member.id] !== undefined

            return assigned ? (
              <button
                key={member.id}
                type="button"
                disabled={busy}
                onClick={() => void mutate('unassign', member)}
                className="w-full flex items-center gap-[9px] px-2.5 py-[7px] rounded-lg text-left bg-fill disabled:opacity-50"
              >
                <Avatar
                  initial={initialOf(member.name)}
                  className="w-[26px] h-[26px] text-[11px]"
                />
                <span>
                  <span className="block text-[13.5px]">
                    {member.name}
                  </span>
                  <span className="block text-[11.5px] text-ink-400">
                    {member.title}
                  </span>
                </span>
                <span className="ml-auto text-[13px] font-bold text-brand">
                  {busy ? '…' : '✓'}
                </span>
              </button>
            ) : (
              <button
                key={member.id}
                type="button"
                disabled={busy}
                onClick={() => void mutate('assign', member)}
                className="w-full flex items-center gap-[9px] px-2.5 py-[7px] rounded-lg text-left hover:bg-fill/60 disabled:opacity-50"
              >
                <Avatar
                  initial={initialOf(member.name)}
                  className="w-[26px] h-[26px] text-[11px]"
                />
                <span>
                  <span className="block text-[13.5px]">
                    {member.name}
                  </span>
                  <span className="block text-[11.5px] text-ink-400">
                    {member.title}
                  </span>
                </span>
              </button>
            )
          })}

        {mutationError && (
          <div
            role="alert"
            className="mt-1 border-t border-open-bg px-2.5 py-2 text-xs text-open-fg"
          >
            {mutationError}
          </div>
        )}
      </Popover>
    </div>
  )
}

function Header({
  breakpoint,
  cur,
  members,
  teamLoading,
  teamError,
}: {
  breakpoint: Breakpoint
  cur: ConversationListItem
  members: OfficeMember[]
  teamLoading: boolean
  teamError: string | null
}) {
  const { state, dispatch } = useInbox()
  const customerInitial = initialOf(cur.customer.name)

  return (
    <div className="h-[66px] flex-none px-5 border-b border-line flex items-center gap-3 relative whitespace-nowrap">
      {breakpoint === 'mobile' && (
        <button
          type="button"
          className="text-[21px] text-brand leading-none flex-none"
          onClick={() => dispatch({ type: 'setMobileView', view: 'list' })}
        >
          ‹
        </button>
      )}

      <Avatar initial={customerInitial} className="w-[46px] h-[46px] text-lg" />

      <div className="min-w-0 overflow-hidden">
        <div className="flex items-center gap-[7px]">
          <span className="font-bold text-base tracking-[-0.3px]">
            {cur.customer.name}
          </span>
          <span className="text-[13.5px] text-ink-500 overflow-hidden text-ellipsis">
            {cur.customer.company}
          </span>
        </div>
        <div className="text-[12.5px] text-ink-400">
          {cur.customer.phoneE164}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2 flex-none">
        <div className="relative flex-none">
          <button
            type="button"
            className={`h-[34px] px-3 border border-line-strong rounded-[9px] flex items-center gap-1.5 text-[13.5px] font-semibold bg-white cursor-pointer ${
              STATUS_TEXT[cur.status]
            }`}
            onClick={() =>
              dispatch({ type: 'setMenu', value: state.menu === 'status' ? null : 'status' })
            }
          >
            <span className={`w-[7px] h-[7px] rounded-full ${STATUS_DOT[cur.status]}`} />
            {cur.status}
            <span className="text-[9px] text-ink-400 ml-0.5">▼</span>
          </button>
          <Popover
            open={state.menu === 'status'}
            onClose={() => dispatch({ type: 'setMenu', value: null })}
            className="top-10 left-0 w-[150px]"
          >
            {STATUSES.map((o) => (
              <MenuItem
                key={o}
                active={o === cur.status}
                onClick={() => dispatch({ type: 'setStatus', value: o })}
              >
                <span className={`w-[7px] h-[7px] rounded-full ${STATUS_DOT[o]}`} />
                {o}
              </MenuItem>
            ))}
          </Popover>
        </div>

        <AssigneePicker
          conversation={cur}
          members={members}
          teamLoading={teamLoading}
          teamError={teamError}
        />

        {cur.archived ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'unarchive' })}
            className="h-[34px] px-3.5 border border-line-strong rounded-[9px] bg-white text-ink-700 flex items-center text-[13.5px] font-semibold hover:border-brand hover:text-brand flex-none whitespace-nowrap"
          >
            보관 해제
          </button>
        ) : (
          <button
            type="button"
            onClick={() => dispatch({ type: 'archive' })}
            className="h-[34px] px-3.5 rounded-[9px] bg-brand text-white flex items-center text-[13.5px] font-semibold shadow-[0_1px_2px_rgba(16,24,40,.1)] hover:bg-brand-hover flex-none whitespace-nowrap"
          >
            보관
          </button>
        )}

        <button
          type="button"
          onClick={() => dispatch({ type: 'toggleCard' })}
          aria-label="고객 카드 토글"
          className={`h-[34px] px-3 rounded-[9px] flex items-center gap-1 text-[13.5px] font-semibold flex-none border ${
            state.cardOpen
              ? 'border-brand text-brand bg-brand-100'
              : 'border-line-strong text-ink-700 bg-white'
          }`}
        >
          <span className="w-[17px] h-3.5 border-[1.5px] border-current rounded-[3px] flex justify-end overflow-hidden">
            <span className="w-[5px] bg-current" />
          </span>
        </button>
      </div>
    </div>
  )
}

function failureFrom(error: unknown): ThreadFailure {
  if (error instanceof ApiRequestError) {
    return {
      code: error.code,
      message: error.message,
    }
  }
  return { message: '요청을 처리하는 중 알 수 없는 오류가 발생했습니다.' }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function Thread({
  conversation,
}: {
  conversation: ConversationListItem
}) {
  const { state, dispatch } = useInbox()
  const { me } = useAuth()
  const thread = threadFor(state, conversation.id)

  const loadPage = useCallback(
    async (
      older: boolean,
      before?: string,
      signal?: AbortSignal,
    ) => {
      dispatch({
        type: 'thread/loadStarted',
        conversationId: conversation.id,
        older,
      })
      try {
        const page = await getConversationMessages(conversation.id, {
          before,
          signal,
        })
        dispatch({
          type: 'thread/loadSucceeded',
          conversationId: conversation.id,
          messages: page.messages,
          nextCursor: page.nextCursor,
          older,
        })
      } catch (error: unknown) {
        if (isAbort(error)) return
        dispatch({
          type: 'thread/loadFailed',
          conversationId: conversation.id,
          message: failureFrom(error).message,
          older,
        })
      }
    },
    [conversation.id, dispatch],
  )

  useEffect(() => {
    const controller = new AbortController()
    void loadPage(false, undefined, controller.signal)
    return () => controller.abort()
  }, [loadPage])

  const requestSend = useCallback(
    async (clientKey: string, body: string) => {
      try {
        const response = await sendConversationMessage(
          conversation.id,
          { clientKey, body },
        )
        dispatch({
          type: 'thread/sendSucceeded',
          conversationId: conversation.id,
          clientKey,
          message: response.message,
        })
      } catch (error: unknown) {
        dispatch({
          type: 'thread/sendFailed',
          conversationId: conversation.id,
          clientKey,
          error: failureFrom(error),
        })
      }
    },
    [conversation.id, dispatch],
  )

  const send = () => {
    const body = state.draft
    const clientKey = crypto.randomUUID()
    dispatch({
      type: 'thread/sendStarted',
      conversationId: conversation.id,
      clientKey,
      body,
      occurredAt: Date.now(),
      sender: {
        id: me.user.id,
        name: me.user.name,
        title: me.user.title,
      },
    })
    void requestSend(clientKey, body)
  }

  const retry = (clientKey: string) => {
    const message = thread.messages.find(
      (candidate) => candidate.clientKey === clientKey,
    )
    if (!message) return
    dispatch({
      type: 'thread/retryStarted',
      conversationId: conversation.id,
      clientKey,
    })
    void requestSend(clientKey, message.body)
  }

  return (
    <>
      <MessageThread
        conversationId={conversation.id}
        customerInitial={initialOf(conversation.customer.name)}
        thread={thread}
        onLoadOlder={() => {
          if (!thread.nextCursor) return
          return loadPage(true, thread.nextCursor)
        }}
        onReload={() => loadPage(false)}
        onRetry={retry}
      />
      <MessageComposer
        draft={state.draft}
        sendError={state.composerError}
        onDraftChange={(value) =>
          dispatch({ type: 'thread/draftChanged', value })
        }
        onSend={send}
      />
    </>
  )
}

export function ChatPane({ breakpoint }: { breakpoint: Breakpoint }) {
  const { state } = useInbox()
  const conversation = currentConv(state)

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface text-sm text-ink-400">
        대화를 선택해 주세요.
      </div>
    )
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-white">
      <Header
        breakpoint={breakpoint}
        cur={conversation}
        members={[]}
        teamLoading
        teamError={null}
      />
      <Thread conversation={conversation} />
    </div>
  )
}
