import { describe, expect, it } from 'vitest'
import type { ConversationListResponse } from '../../shared/wire/conversation'
import type { ConversationMessage } from '../../shared/wire/message'
import {
  ACTION_TYPES,
  initialState,
  reducer,
  type Action,
  type InboxState,
} from './inbox'
import { threadFor } from './thread'

const ACTION_TYPES_AFTER_LIST_API = [
  'select',
  'setPage',
  'setTab',
  'toggleCard',
  'setMobileView',
  'setQuery',
  'setFilter',
  'setScope',
  'setMenu',
  'toggleArchivedView',
  'conversationListLoadStarted',
  'conversationListLoadSucceeded',
  'conversationListLoadFailed',
  'setStatus',
  'archive',
  'unarchive',
  'assigneeAssigned',
  'assigneeUnassigned',
  'thread/loadStarted',
  'thread/loadSucceeded',
  'thread/loadFailed',
  'thread/draftChanged',
  'thread/sendStarted',
  'thread/sendSucceeded',
  'thread/retryStarted',
  'thread/sendFailed',
  'thread/composerError',
  'draftReply',
  'toggleTodo',
  'linkFolder',
  'unlinkFolder',
  'startEdit',
  'cancelEdit',
  'saveEdit',
  'setEditName',
  'setEditOrg',
  'setEditField',
  'addTask',
  'editTask',
  'cancelTask',
  'saveTask',
  'removeTask',
  'setTaskDraft',
  'addNote',
  'editNote',
  'cancelNote',
  'saveNote',
  'removeNote',
  'setNoteDraft',
  'toggleAi',
  'toggleOffice',
  'loadTeam',
  'failTeam',
  'upsertTeamMember',
  'openInvite',
  'closeInvite',
  'setInviteEmail',
  'setInviteRole',
  'setAiDraft',
  'askAi',
  'aiReply',
  'toastArrive',
  'openToast',
  'dismissToast',
] as const satisfies ReadonlyArray<Action['type']>

function run(actions: Action[]): InboxState {
  return actions.reduce(reducer, initialState)
}

function listResponse(
  ids: string[],
  nextCursor: string | null = null,
): ConversationListResponse {
  return {
    conversations: ids.map((id, index) => ({
      id,
      customer: {
        id: `customer-${id}`,
        name: `고객 ${id}`,
        company: `회사 ${id}`,
        phoneE164: `+82100000000${index}`,
      },
      preview: `미리보기 ${id}`,
      lastMessageAt: 1_785_233_160_000 - index,
      unreadCount: index,
      assignees: [],
      status: '미처리',
      label: '',
      archived: false,
      version: 1,
    })),
    nextCursor,
    facets: {
      status: {
        전체: ids.length,
        미처리: ids.length,
        처리중: 0,
        완료: 0,
      },
      scope: { all: ids.length, mine: 0, none: ids.length },
      archive: { active: ids.length, archived: 12 },
    },
  }
}

function message(
  id: string,
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id,
    direction: 'in',
    channel: 'SMS',
    title: null,
    body: id,
    sender: null,
    occurredAt: 1_785_233_160_000,
    deliveryStatus: '수신',
    resultCode: null,
    deliveredAt: null,
    errorText: null,
    attachments: [],
    ...overrides,
  }
}

describe('inbox reducer', () => {
  it('preserves every registered action name after adding the list API', () => {
    expect([...ACTION_TYPES].sort()).toEqual(
      [...ACTION_TYPES_AFTER_LIST_API].sort(),
    )
  })

  it('preserves a representative list action sequence', () => {
    const response = listResponse(
      ['conversation-1', 'conversation-2'],
      'next-page',
    )
    const state = run([
      {
        type: 'conversationListLoadStarted',
        requestId: 1,
        append: false,
      },
      {
        type: 'conversationListLoadSucceeded',
        requestId: 1,
        append: false,
        response,
      },
      { type: 'select', id: 'conversation-2' },
      { type: 'setStatus', value: '완료' },
      { type: 'archive' },
    ])

    const selectedAfter = {
      ...response.conversations[1],
      status: '완료' as const,
      archived: true,
    }

    expect(state).toEqual({
      ...initialState,
      selected: 'conversation-2',
      mobileView: 'chat',
      convs: [response.conversations[0], selectedAfter],
      facets: response.facets,
      nextCursor: 'next-page',
      listLoadStatus: 'loaded',
      listRequestId: 1,
    })
  })

  it('merges cursor pages by id without duplicating conversations', () => {
    const first = listResponse(['conversation-1', 'conversation-2'], 'next')
    const second = listResponse(['conversation-2', 'conversation-3'])
    second.conversations[0] = {
      ...second.conversations[0],
      preview: '갱신된 미리보기',
    }

    const state = run([
      {
        type: 'conversationListLoadStarted',
        requestId: 1,
        append: false,
      },
      {
        type: 'conversationListLoadSucceeded',
        requestId: 1,
        append: false,
        response: first,
      },
      {
        type: 'conversationListLoadStarted',
        requestId: 2,
        append: true,
      },
      {
        type: 'conversationListLoadSucceeded',
        requestId: 2,
        append: true,
        response: second,
      },
    ])

    expect(state.convs.map(({ id }) => id)).toEqual([
      'conversation-1',
      'conversation-2',
      'conversation-3',
    ])
    expect(state.convs[1].preview).toBe('갱신된 미리보기')
    expect(state.facets).toBe(second.facets)
  })

  it('applies assignee directions by immutable user id', () => {
    const response = listResponse(['conversation-1'])
    const state = run([
      {
        type: 'conversationListLoadStarted',
        requestId: 1,
        append: false,
      },
      {
        type: 'conversationListLoadSucceeded',
        requestId: 1,
        append: false,
        response,
      },
      {
        type: 'assigneeAssigned',
        conversationId: 'conversation-1',
        assignee: { id: 'user-1', name: '김세무' },
      },
      {
        type: 'assigneeAssigned',
        conversationId: 'conversation-1',
        assignee: { id: 'user-1', name: '바뀐 이름' },
      },
      {
        type: 'assigneeAssigned',
        conversationId: 'conversation-1',
        assignee: { id: 'user-2', name: '박상담' },
      },
      {
        type: 'assigneeUnassigned',
        conversationId: 'conversation-1',
        userId: 'user-1',
      },
    ])

    expect(state.convs[0].assignees).toEqual([
      { id: 'user-2', name: '박상담' },
    ])
  })

  it('keeps the thread separate and replaces an optimistic retry by clientKey', () => {
    const response = listResponse(['conversation-1'])
    const state = run([
      {
        type: 'conversationListLoadStarted',
        requestId: 1,
        append: false,
      },
      {
        type: 'conversationListLoadSucceeded',
        requestId: 1,
        append: false,
        response,
      },
      {
        type: 'thread/loadStarted',
        conversationId: 'conversation-1',
        older: false,
      },
      {
        type: 'thread/loadSucceeded',
        conversationId: 'conversation-1',
        messages: [message('inbound-1')],
        nextCursor: null,
        older: false,
      },
      {
        type: 'thread/draftChanged',
        value: '확인했습니다.',
      },
      {
        type: 'thread/sendStarted',
        conversationId: 'conversation-1',
        clientKey: 'client-key-1',
        body: '확인했습니다.',
        occurredAt: 1_785_233_160_001,
        sender: {
          id: 'user-park',
          name: '박상담',
          title: '상담 담당',
        },
      },
      {
        type: 'thread/sendFailed',
        conversationId: 'conversation-1',
        clientKey: 'client-key-1',
        error: { message: '네트워크 오류' },
      },
      {
        type: 'thread/retryStarted',
        conversationId: 'conversation-1',
        clientKey: 'client-key-1',
      },
      {
        type: 'thread/sendSucceeded',
        conversationId: 'conversation-1',
        clientKey: 'client-key-1',
        message: message('outbound-1', {
          direction: 'out',
          body: '확인했습니다.',
          sender: {
            id: 'user-park',
            name: '박상담',
            title: '상담 담당',
          },
          occurredAt: 1_785_233_160_001,
          deliveryStatus: '접수',
        }),
      },
    ])

    expect(state.convs[0]).not.toHaveProperty('messages')
    expect(
      threadFor(state, 'conversation-1').messages,
    ).toEqual([
      message('inbound-1'),
      {
        ...message('outbound-1', {
          direction: 'out',
          body: '확인했습니다.',
          sender: {
            id: 'user-park',
            name: '박상담',
            title: '상담 담당',
          },
          occurredAt: 1_785_233_160_001,
          deliveryStatus: '접수',
        }),
        clientKey: 'client-key-1',
        requestState: null,
      },
    ])
    expect(state.draft).toBe('')
    expect(state.composerError).toBeNull()
  })

  it('discards a response from an older request', () => {
    const stale = listResponse(['stale'])
    const state = run([
      {
        type: 'conversationListLoadStarted',
        requestId: 1,
        append: false,
      },
      {
        type: 'conversationListLoadStarted',
        requestId: 2,
        append: false,
      },
      {
        type: 'conversationListLoadSucceeded',
        requestId: 1,
        append: false,
        response: stale,
      },
    ])

    expect(state.convs).toEqual([])
    expect(state.listLoadStatus).toBe('loading')
    expect(state.listRequestId).toBe(2)
  })

  it('keeps first-load and pagination failures distinct', () => {
    const firstFailure = run([
      {
        type: 'conversationListLoadStarted',
        requestId: 1,
        append: false,
      },
      {
        type: 'conversationListLoadFailed',
        requestId: 1,
        append: false,
        message: '첫 요청 실패',
      },
    ])
    const response = listResponse(['conversation-1'], 'next')
    const paginationFailure = run([
      {
        type: 'conversationListLoadStarted',
        requestId: 1,
        append: false,
      },
      {
        type: 'conversationListLoadSucceeded',
        requestId: 1,
        append: false,
        response,
      },
      {
        type: 'conversationListLoadStarted',
        requestId: 2,
        append: true,
      },
      {
        type: 'conversationListLoadFailed',
        requestId: 2,
        append: true,
        message: '추가 요청 실패',
      },
    ])

    expect(firstFailure).toMatchObject({
      convs: [],
      listLoadStatus: 'failed',
      listError: '첫 요청 실패',
    })
    expect(paginationFailure).toMatchObject({
      convs: response.conversations,
      listLoadStatus: 'loaded',
      loadingMore: false,
      listError: '추가 요청 실패',
    })
  })
})
