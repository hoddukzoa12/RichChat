import {
  LMS_MAX_BYTES,
  SMS_MAX_BYTES,
  containsEmoji,
  pickMessageType,
  smsByteLength,
  type MessageType,
} from '../../shared/sms'
import type {
  ConversationListAssignee,
  ConversationListItem,
} from '../../shared/wire/conversation'
import type {
  ConversationMessage,
  MessageSender,
} from '../../shared/wire/message'
import type { ActionHandlers, InboxState } from './inbox'

export type ThreadRequestState = 'sending' | 'failed' | null
export type ComposerIssueCode =
  | 'MSG_EMOJI_UNSUPPORTED'
  | 'MSG_TOO_LONG'

export interface ThreadFailure {
  code?: string
  message: string
}

export interface ThreadMessage extends ConversationMessage {
  clientKey?: string
  requestState?: ThreadRequestState
  requestError?: ThreadFailure
}

export interface ConversationThread {
  messages: ThreadMessage[]
  nextCursor: string | null
  loadStatus: 'idle' | 'loading' | 'ready' | 'failed'
  loadingOlder: boolean
  loadError: string | null
}

export interface ThreadState {
  draft: string
  threads: Record<string, ConversationThread>
  composerError: ThreadFailure | null
}

export const initialThreadState: ThreadState = {
  draft: '',
  threads: {},
  composerError: null,
}

export const EMPTY_THREAD: Readonly<ConversationThread> = Object.freeze({
  messages: [],
  nextCursor: null,
  loadStatus: 'idle',
  loadingOlder: false,
  loadError: null,
})

export interface ComposerMetrics {
  byteLength: number
  limit: number
  messageType: MessageType
  issue: ComposerIssueCode | null
}

/** 컴포저와 발송 액션이 공유하는 단일 검증 결과다. */
export function composerMetrics(text: string): ComposerMetrics {
  const byteLength = smsByteLength(text)
  const messageType = pickMessageType(text)
  const issue = containsEmoji(text)
    ? 'MSG_EMOJI_UNSUPPORTED'
    : messageType === 'TOO_LONG'
      ? 'MSG_TOO_LONG'
      : null

  return {
    byteLength,
    limit: messageType === 'SMS' ? SMS_MAX_BYTES : LMS_MAX_BYTES,
    messageType,
    issue,
  }
}

function threadKey(conversationId: string): string {
  return conversationId
}

export function threadFor(
  state: ThreadState,
  conversationId: string,
): ConversationThread {
  return state.threads[threadKey(conversationId)] ?? EMPTY_THREAD
}

type MergePosition = 'append' | 'prepend'

function matchingIndex(
  messages: ThreadMessage[],
  candidate: ThreadMessage,
): number {
  if (candidate.clientKey) {
    const clientKeyIndex = messages.findIndex(
      (message) => message.clientKey === candidate.clientKey,
    )
    if (clientKeyIndex >= 0) return clientKeyIndex
  }

  return messages.findIndex((message) => message.id === candidate.id)
}

function mergeAdditions(
  additions: ThreadMessage[],
  candidate: ThreadMessage,
): void {
  const index = matchingIndex(additions, candidate)
  if (index >= 0) {
    additions[index] = candidate
    return
  }
  additions.push(candidate)
}

/**
 * 낙관 말풍선은 clientKey로 먼저 교체하고, 서버 페이지 항목은 id로 합친다.
 * 서버가 준 페이지 내부 순서는 바꾸지 않는다.
 */
export function mergeThreadMessages(
  current: ThreadMessage[],
  incoming: ThreadMessage[],
  position: MergePosition,
): ThreadMessage[] {
  const merged = [...current]
  const additions: ThreadMessage[] = []

  for (const candidate of incoming) {
    const index = matchingIndex(merged, candidate)
    if (index >= 0) {
      merged[index] = candidate
    } else {
      mergeAdditions(additions, candidate)
    }
  }

  return position === 'prepend'
    ? [...additions, ...merged]
    : [...merged, ...additions]
}

export type ThreadSliceAction =
  | {
      type: 'thread/loadStarted'
      conversationId: string
      older: boolean
    }
  | {
      type: 'thread/loadSucceeded'
      conversationId: string
      messages: ConversationMessage[]
      nextCursor: string | null
      older: boolean
    }
  | {
      type: 'thread/loadFailed'
      conversationId: string
      message: string
      older: boolean
    }
  | { type: 'thread/draftChanged'; value: string }
  | {
      type: 'thread/sendStarted'
      conversationId: string
      clientKey: string
      body: string
      occurredAt: number
      sender: MessageSender
    }
  | {
      type: 'thread/sendSucceeded'
      conversationId: string
      clientKey: string
      message: ConversationMessage
    }
  | {
      type: 'thread/retryStarted'
      conversationId: string
      clientKey: string
    }
  | {
      type: 'thread/sendFailed'
      conversationId: string
      clientKey: string
      error: ThreadFailure
    }
  | { type: 'thread/composerError'; error: ThreadFailure | null }

type ThreadSliceHandlers = {
  [Type in ThreadSliceAction['type']]: (
    state: ThreadState,
    action: Extract<ThreadSliceAction, { type: Type }>,
  ) => ThreadState
}

function patchThread(
  state: ThreadState,
  conversationId: string,
  update: (thread: ConversationThread) => ConversationThread,
): ThreadState {
  const key = threadKey(conversationId)
  return {
    ...state,
    threads: {
      ...state.threads,
      [key]: update(threadFor(state, conversationId)),
    },
  }
}

const threadSliceHandlers = {
  'thread/loadStarted': (state, action) =>
    patchThread(state, action.conversationId, (thread) => ({
      ...thread,
      loadStatus: action.older ? thread.loadStatus : 'loading',
      loadingOlder: action.older,
      loadError: null,
    })),

  'thread/loadSucceeded': (state, action) =>
    patchThread(state, action.conversationId, (thread) => ({
      ...thread,
      messages: action.older
        ? mergeThreadMessages(
            thread.messages,
            action.messages,
            'prepend',
          )
        : mergeThreadMessages([], action.messages, 'append'),
      nextCursor: action.nextCursor,
      loadStatus: 'ready',
      loadingOlder: false,
      loadError: null,
    })),

  'thread/loadFailed': (state, action) =>
    patchThread(state, action.conversationId, (thread) => ({
      ...thread,
      loadStatus: action.older ? thread.loadStatus : 'failed',
      loadingOlder: false,
      loadError: action.message,
    })),

  'thread/draftChanged': (state, action) => ({
    ...state,
    draft: action.value,
    composerError: null,
  }),

  'thread/sendStarted': (state, action) => {
    const metrics = composerMetrics(action.body)
    if (metrics.issue || metrics.messageType === 'TOO_LONG') return state

    const optimistic: ThreadMessage = {
      id: `optimistic:${action.clientKey}`,
      clientKey: action.clientKey,
      direction: 'out',
      channel: metrics.messageType,
      title: null,
      body: action.body,
      sender: action.sender,
      occurredAt: action.occurredAt,
      deliveryStatus: '대기',
      resultCode: null,
      deliveredAt: null,
      errorText: null,
      attachments: [],
      requestState: 'sending',
    }

    return patchThread(
      {
        ...state,
        draft: '',
        composerError: null,
      },
      action.conversationId,
      (thread) => ({
        ...thread,
        messages: mergeThreadMessages(
          thread.messages,
          [optimistic],
          'append',
        ),
      }),
    )
  },

  'thread/sendSucceeded': (state, action) =>
    patchThread(state, action.conversationId, (thread) => ({
      ...thread,
      messages: mergeThreadMessages(
        thread.messages,
        [
          {
            ...action.message,
            clientKey: action.clientKey,
            requestState: null,
          },
        ],
        'append',
      ),
    })),

  'thread/retryStarted': (state, action) =>
    patchThread(
      { ...state, composerError: null },
      action.conversationId,
      (thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.clientKey === action.clientKey
            ? {
                ...message,
                requestState: 'sending',
                requestError: undefined,
              }
            : message,
        ),
      }),
    ),

  'thread/sendFailed': (state, action) =>
    patchThread(
      { ...state, composerError: action.error },
      action.conversationId,
      (thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.clientKey === action.clientKey
            ? {
                ...message,
                requestState: 'failed',
                requestError: action.error,
              }
            : message,
        ),
      }),
    ),

  'thread/composerError': (state, action) => ({
    ...state,
    composerError: action.error,
  }),
} satisfies ThreadSliceHandlers

export function threadSliceReducer(
  state: ThreadState,
  action: ThreadSliceAction,
): ThreadState {
  const handler = threadSliceHandlers[action.type] as (
    current: ThreadState,
    nextAction: never,
  ) => ThreadState
  return handler(state, action as never)
}

export type ThreadAction =
  | { type: 'select'; id: string }
  | { type: 'draftReply' }
  | {
      type: 'assigneeAssigned'
      conversationId: string
      assignee: ConversationListAssignee
    }
  | {
      type: 'assigneeUnassigned'
      conversationId: string
      userId: string
    }
  | ThreadSliceAction

function reduceInboxThread(
  state: InboxState,
  action: ThreadSliceAction,
): InboxState {
  return threadSliceReducer(state, action) as InboxState
}

function patchConversation(
  conversations: ConversationListItem[],
  conversationId: string,
  update: (
    conversation: ConversationListItem,
  ) => ConversationListItem,
): ConversationListItem[] {
  return conversations.map((conversation) =>
    conversation.id === conversationId
      ? update(conversation)
      : conversation,
  )
}

export const threadHandlers = {
  select: (state, action) => ({
    ...state,
    selected: action.id,
    menu: null,
    draft: '',
    composerError: null,
    mobileView: 'chat',
    editDraft: null,
  }),

  draftReply: (state) => ({ ...state, draft: '확인 후 회신드리겠습니다.' }),

  assigneeAssigned: (state, action) => ({
    ...state,
    convs: patchConversation(
      state.convs,
      action.conversationId,
      (conversation) =>
        conversation.assignees.some(
          (assignee) => assignee.id === action.assignee.id,
        )
          ? conversation
          : {
              ...conversation,
              assignees: [
                ...conversation.assignees,
                action.assignee,
              ],
            },
    ),
  }),

  assigneeUnassigned: (state, action) => ({
    ...state,
    convs: patchConversation(
      state.convs,
      action.conversationId,
      (conversation) => ({
        ...conversation,
        assignees: conversation.assignees.filter(
          (assignee) => assignee.id !== action.userId,
        ),
      }),
    ),
  }),

  'thread/loadStarted': (state, action) =>
    reduceInboxThread(state, action),

  'thread/loadSucceeded': (state, action) =>
    reduceInboxThread(state, action),

  'thread/loadFailed': (state, action) =>
    reduceInboxThread(state, action),

  'thread/draftChanged': (state, action) =>
    reduceInboxThread(state, action),

  'thread/sendStarted': (state, action) =>
    reduceInboxThread(state, action),

  'thread/sendSucceeded': (state, action) =>
    reduceInboxThread(state, action),

  'thread/retryStarted': (state, action) =>
    reduceInboxThread(state, action),

  'thread/sendFailed': (state, action) =>
    reduceInboxThread(state, action),

  'thread/composerError': (state, action) =>
    reduceInboxThread(state, action),
} satisfies ActionHandlers<InboxState, ThreadAction>
