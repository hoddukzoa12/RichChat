import { describe, expect, it } from 'vitest'
import type {
  ConversationDetail,
  ConversationListResponse,
} from '../../shared/wire/conversation'
import type { ConversationMessage } from '../../shared/wire/message'
import {
  ACTION_TYPES,
  initialState,
  reducer,
  type Action,
  type InboxState,
} from './inbox'
import { visibleConversations } from './selectors'
import { threadFor } from './thread'

const EXPECTED_ACTION_TYPES = [
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
  'conversationStarted',
  'conversationWriteApplied',
  'assigneeAssigned',
  'assigneeUnassigned',
  'thread/loadStarted',
  'thread/loadSucceeded',
  'thread/loadFailed',
  'thread/readStarted',
  'thread/readFailed',
  'thread/draftChanged',
  'thread/sendStarted',
  'thread/sendSucceeded',
  'thread/retryStarted',
  'thread/sendFailed',
  'thread/composerError',
  'draftReply',
  'cardData',
  'toggleAi',
  'toggleOffice',
  'loadTeam',
  'failTeam',
  'upsertTeamMember',
  'openInvite',
  'closeInvite',
  'setInviteEmail',
  'setInviteName',
  'setInviteTitle',
  'setInviteRole',
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
      officeChannel: {
        id: 'office-channel-1',
        label: '업무폰 1',
        value: '01012345678',
      },
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

function conversationDetail(): ConversationDetail {
  return {
    id: 'conversation-1',
    officeChannel: {
      id: 'office-channel-1',
      label: '업무폰 1',
      value: '01012345678',
    },
    status: '미처리',
    label: '',
    archived: false,
    version: 1,
    customer: {
      id: 'customer-conversation-1',
      name: '고객 conversation-1',
      company: '리치 · 세무',
      roleTitle: '대표',
      phoneE164: '+821000000000',
      version: 1,
      fields: [
        { id: 'field-1', key: '유형', value: '개인', sortOrder: 0 },
        { id: 'field-2', key: '과세', value: '일반', sortOrder: 1 },
        { id: 'field-3', key: '업종', value: '도소매', sortOrder: 2 },
      ],
    },
    assignees: [],
    tasks: [
      {
        id: 'task-1',
        name: '부가세 신고',
        sub: '',
        kind: 'done',
        sortOrder: 0,
        createdById: 'user-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    notes: [
      {
        id: 'note-1',
        authorId: 'user-1',
        authorName: '박상담',
        body: '첫 메모',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'note-2',
        authorId: 'user-2',
        authorName: '김상담',
        body: '가운데 메모',
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'note-3',
        authorId: 'user-1',
        authorName: '박상담',
        body: '마지막 메모',
        createdAt: 3,
        updatedAt: 3,
      },
    ],
  }
}

describe('inbox reducer', () => {
  it('preserves every registered action name after adding the list API', () => {
    expect([...ACTION_TYPES].sort()).toEqual(
      [...EXPECTED_ACTION_TYPES].sort(),
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
      {
        type: 'conversationWriteApplied',
        conversationId: 'conversation-2',
        conversation: {
          status: '완료',
          label: '',
          archived: false,
          version: 2,
        },
      },
      {
        type: 'conversationWriteApplied',
        conversationId: 'conversation-2',
        conversation: {
          status: '완료',
          label: '',
          archived: true,
          version: 3,
        },
      },
    ])

    const selectedAfter = {
      ...response.conversations[1],
      status: '완료' as const,
      archived: true,
      version: 3,
    }

    expect(state).toEqual({
      ...initialState,
      selected: 'conversation-2',
      mobileView: 'chat',
      convs: [response.conversations[0], selectedAfter],
      facets: {
        ...response.facets,
        status: {
          전체: 1,
          미처리: 1,
          처리중: 0,
          완료: 0,
        },
        archive: { active: 1, archived: 13 },
      },
      nextCursor: 'next-page',
      listLoadStatus: 'loaded',
      listRequestId: 1,
    })
  })

  it('opens a started conversation outside the current filters', () => {
    const response = listResponse(['conversation-1'])
    const loaded = run([
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
      { type: 'setQuery', value: '이전 검색' },
      { type: 'setFilter', value: '미처리' },
      { type: 'setScope', value: 'none' },
    ])
    const started = {
      ...response.conversations[0],
      id: 'conversation-started',
      customer: {
        ...response.conversations[0].customer,
        id: 'customer-started',
        phoneE164: '+821012345678',
      },
      preview: '',
      lastMessageAt: null,
      assignees: [{ id: 'user-1', name: '박상담' }],
      status: '처리중' as const,
    }

    const state = reducer(loaded, {
      type: 'conversationStarted',
      conversation: started,
    })

    expect(state.convs[0]).toEqual(started)
    expect(state.selected).toBe(started.id)
    expect(state.query).toBe('')
    expect(state.filter).toBe('전체')
    expect(state.scope).toBe('all')
    expect(state.mobileView).toBe('chat')
  })

  it('updates status facets and restores the previous optimistic value', () => {
    const response = listResponse(['conversation-1', 'conversation-2'])
    const loaded = run([
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
    ])
    const optimistic = reducer(loaded, {
      type: 'conversationWriteApplied',
      conversationId: 'conversation-1',
      conversation: {
        status: '처리중',
        label: '부가세',
        archived: false,
        version: 1,
      },
    })

    expect(optimistic.convs[0]).toMatchObject({
      status: '처리중',
      label: '부가세',
      version: 1,
    })
    expect(optimistic.facets.status).toEqual({
      전체: 2,
      미처리: 1,
      처리중: 1,
      완료: 0,
    })

    const rolledBack = reducer(optimistic, {
      type: 'conversationWriteApplied',
      conversationId: 'conversation-1',
      conversation: {
        status: '미처리',
        label: '',
        archived: false,
        version: 1,
      },
    })

    expect(rolledBack.convs[0]).toEqual(response.conversations[0])
    expect(rolledBack.facets.status).toEqual(response.facets.status)
  })

  it('moves archived conversations without changing their status', () => {
    const response = listResponse(['conversation-1'])
    response.conversations[0] = {
      ...response.conversations[0],
      status: '처리중',
    }
    response.facets.status = {
      전체: 1,
      미처리: 0,
      처리중: 1,
      완료: 0,
    }
    const loaded = run([
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
    ])
    const archived = reducer(loaded, {
      type: 'conversationWriteApplied',
      conversationId: 'conversation-1',
      conversation: {
        status: '처리중',
        label: '',
        archived: true,
        version: 2,
      },
    })

    expect(archived.convs[0]).toMatchObject({
      status: '처리중',
      archived: true,
      version: 2,
    })
    expect(visibleConversations(archived)).toEqual([])
    expect(archived.facets.archive).toEqual({
      active: 0,
      archived: 13,
    })

    const archivedView = {
      ...archived,
      archivedView: true,
    }
    expect(visibleConversations(archivedView)).toEqual([
      archived.convs[0],
    ])
  })

  it('keeps card detail separate while synchronizing customer list fields', () => {
    const response = listResponse(['conversation-1'])
    const detail = conversationDetail()
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
      { type: 'select', id: detail.id },
      {
        type: 'cardData',
        action: { type: 'cardLoadSucceeded', detail },
      },
      {
        type: 'cardData',
        action: { type: 'startEdit', conversationId: detail.id },
      },
      {
        type: 'cardData',
        action: { type: 'removeEditField', fieldId: 'field-2' },
      },
      {
        type: 'cardData',
        action: {
          type: 'setEditField',
          fieldId: 'field-3',
          patch: { value: '전자상거래' },
        },
      },
      {
        type: 'cardData',
        action: {
          type: 'customerSaved',
          conversationId: detail.id,
          customer: {
            id: detail.customer.id,
            name: '바뀐 고객',
            company: '리치 · 세무법인',
            roleTitle: '공동대표',
            phoneE164: detail.customer.phoneE164,
            version: 2,
            updatedAt: 4,
            fields: [
              {
                id: 'field-1',
                key: '유형',
                value: '개인',
                sortOrder: 0,
                updatedAt: 4,
              },
              {
                id: 'field-3',
                key: '업종',
                value: '전자상거래',
                sortOrder: 1,
                updatedAt: 4,
              },
            ],
          },
        },
      },
      {
        type: 'cardData',
        action: {
          type: 'taskUpdateOptimistic',
          conversationId: detail.id,
          taskId: 'task-1',
          patch: {
            name: '부가세 신고',
            sub: '완료 확인',
            kind: 'done',
          },
        },
      },
      {
        type: 'cardData',
        action: { type: 'noteDeleteStarted', noteId: 'note-2' },
      },
      {
        type: 'cardData',
        action: {
          type: 'noteDeleteSucceeded',
          conversationId: detail.id,
          noteId: 'note-2',
        },
      },
      {
        type: 'cardData',
        action: {
          type: 'noteUpdateOptimistic',
          conversationId: detail.id,
          noteId: 'note-3',
          body: '수정한 마지막 메모',
          updatedAt: 5,
        },
      },
    ])

    expect(state.convs[0].customer).toMatchObject({
      name: '바뀐 고객',
      company: '리치 · 세무법인',
    })
    expect(state.cardEntries[detail.id].detail).toMatchObject({
      customer: {
        roleTitle: '공동대표',
        version: 2,
        fields: [
          { id: 'field-1' },
          { id: 'field-3', value: '전자상거래' },
        ],
      },
      tasks: [{ id: 'task-1', kind: 'done', sub: '완료 확인' }],
      notes: [
        { id: 'note-1' },
        { id: 'note-3', body: '수정한 마지막 메모' },
      ],
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

  it('optimistically clears unread messages and restores them after failure', () => {
    const response = listResponse(['conversation-1', 'conversation-2'])
    response.conversations[0] = {
      ...response.conversations[0],
      unreadCount: 3,
    }
    const loaded = run([
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
        type: 'thread/readStarted',
        conversationId: 'conversation-1',
      },
    ])

    expect(loaded.convs.map(({ unreadCount }) => unreadCount)).toEqual([
      0,
      1,
    ])

    const restored = reducer(loaded, {
      type: 'thread/readFailed',
      conversationId: 'conversation-1',
      unreadCount: 3,
    })
    expect(restored.convs.map(({ unreadCount }) => unreadCount)).toEqual([
      3,
      1,
    ])

    const withNewerUnread = {
      ...loaded,
      convs: loaded.convs.map((conversation) =>
        conversation.id === 'conversation-1'
          ? { ...conversation, unreadCount: 4 }
          : conversation,
      ),
    }
    const preserved = reducer(withNewerUnread, {
      type: 'thread/readFailed',
      conversationId: 'conversation-1',
      unreadCount: 3,
    })
    expect(preserved.convs[0].unreadCount).toBe(4)
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
