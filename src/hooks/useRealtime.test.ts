import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type {
  ConversationDetail,
  ConversationListItem,
  ConversationListResponse,
} from '../../shared/wire/conversation'
import type { EventEnvelope } from '../../shared/wire/event'
import type { MessagePageResponse } from '../../shared/wire/message'
import { ApiRequestError } from '../api/client'
import { initialState } from '../state/inbox'
import { RealtimeCursor } from '../state/realtime'
import {
  createPollingSchedule,
  pollingDelay,
  reconnectDelay,
  reloadInboxState,
  realtimeWebSocketUrl,
  recoverGoneCursor,
} from './useRealtime'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

class FakeSocket {
  readonly #listeners: Record<'open' | 'close', Set<() => void>> = {
    open: new Set(),
    close: new Set(),
  }

  addEventListener(
    type: 'open' | 'close',
    listener: () => void,
  ): void {
    this.#listeners[type].add(listener)
  }

  dispatch(type: 'open' | 'close'): void {
    for (const listener of this.#listeners[type]) listener()
  }
}

const conversation: ConversationListItem = {
  id: 'conversation-1',
  officeChannel: {
    id: 'office-channel-1',
    label: '업무폰 1',
  },
  customer: {
    id: 'customer-1',
    name: '김리치',
    company: '리치상사',
    phoneE164: '+821012345678',
  },
  preview: '문의드립니다.',
  lastMessageAt: 1_900_000_000_000,
  unreadCount: 1,
  assignees: [],
  status: '미처리',
  label: '',
  archived: false,
  version: 1,
}

const listResponse: ConversationListResponse = {
  conversations: [conversation],
  nextCursor: null,
  facets: {
    status: { 전체: 1, 미처리: 1, 처리중: 0, 완료: 0 },
    scope: { all: 1, mine: 0, none: 1 },
    archive: { active: 1, archived: 0 },
  },
}

const detail: ConversationDetail = {
  id: conversation.id,
  officeChannel: conversation.officeChannel,
  status: conversation.status,
  label: '',
  archived: false,
  version: 1,
  customer: {
    ...conversation.customer,
    roleTitle: '대표',
    version: 1,
    fields: [],
  },
  assignees: [],
  tasks: [],
  notes: [],
}

function inboundEvent(): EventEnvelope {
  return {
    officeSeq: 1,
    type: 'message.created',
    entity: 'message',
    entityId: 'message-1',
    // 현재 MO 이벤트에는 대화 ID가 없으므로 열린 스레드를 보정한다.
    conversationId: null,
    actorKind: 'customer',
    actorId: null,
    payload: {},
    createdAt: 1_900_000_000_001,
  }
}

describe('Realtime subscription', () => {
  it('uses the same-origin socket path without query credentials', () => {
    const url = realtimeWebSocketUrl({
      href: 'https://rich.example/inbox?token=do-not-copy',
      protocol: 'https:',
    })

    expect(url).toBe('wss://rich.example/api/realtime')
    expect(new URL(url).search).toBe('')
  })

  it('uses an insecure socket only for an insecure page', () => {
    expect(
      realtimeWebSocketUrl({
        href: 'http://localhost:5173/',
        protocol: 'http:',
      }),
    ).toBe('ws://localhost:5173/api/realtime')
  })

  it('reconnects with exponential backoff capped at thirty seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(reconnectDelay)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
    ])
  })

  it('polls less often while the page is hidden', () => {
    expect(pollingDelay(false, false)).toBe(5_000)
    expect(pollingDelay(true, false)).toBe(30_000)
    expect(pollingDelay(false, true)).toBe(60_000)
    expect(pollingDelay(true, true)).toBe(300_000)
  })

  it('reschedules polling immediately across socket transitions', async () => {
    vi.useFakeTimers()
    const poll = vi.fn(() => Promise.resolve())
    const schedule = createPollingSchedule(poll, () => false)
    const socket = new FakeSocket()
    schedule.observe(socket)
    schedule.start()

    await vi.advanceTimersByTimeAsync(4_999)
    socket.dispatch('open')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(poll).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(1)

    socket.dispatch('close')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(poll).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(2)
    schedule.stop()
  })

  it('reloads server state before adopting a gone cursor', async () => {
    const cursor = new RealtimeCursor()
    const controller = new AbortController()
    const fullResync = vi.fn(async () => {
      expect(cursor.lastSeq).toBe(0)
    })
    const error = new ApiRequestError('server', 'gone', {
      status: 410,
      code: 'GONE',
      detail: { currentCursor: 12 },
    })

    await expect(
      recoverGoneCursor(
        error,
        cursor,
        fullResync,
        controller.signal,
      ),
    ).resolves.toBe(true)

    expect(fullResync).toHaveBeenCalledWith(controller.signal)
    expect(cursor.lastSeq).toBe(12)
  })

  it('rejects a gone response without a valid shared cursor detail', async () => {
    const cursor = new RealtimeCursor()
    const fullResync = vi.fn(() => Promise.resolve())
    const error = new ApiRequestError('server', 'gone', {
      status: 410,
      code: 'GONE',
      detail: { currentCursor: -1 },
    })

    await expect(
      recoverGoneCursor(
        error,
        cursor,
        fullResync,
        new AbortController().signal,
      ),
    ).resolves.toBe(false)

    expect(fullResync).not.toHaveBeenCalled()
    expect(cursor.lastSeq).toBe(0)
  })

  it('reloads the list, loaded threads, and cards for a full resync', async () => {
    const messagePage: MessagePageResponse = {
      messages: [],
      nextCursor: null,
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/messages')) {
        return Promise.resolve(Response.json(messagePage))
      }
      if (path === '/api/conversations/conversation-1') {
        return Promise.resolve(
          Response.json({ conversation: detail }),
        )
      }
      return Promise.resolve(Response.json(listResponse))
    })
    vi.stubGlobal('fetch', fetchMock)
    const state = {
      ...initialState,
      convs: [conversation],
      selected: conversation.id,
      listRequestId: 4,
      threads: {
        [conversation.id]: {
          messages: [],
          nextCursor: null,
          loadStatus: 'ready' as const,
          loadingOlder: false,
          loadError: null,
        },
      },
      cardEntries: {
        [conversation.id]: {
          status: 'ready' as const,
          detail,
          error: null,
        },
      },
    }
    const dispatch = vi.fn()

    await reloadInboxState(
      state,
      dispatch,
      [],
      true,
      new AbortController().signal,
    )

    expect(
      fetchMock.mock.calls.map(([path]) => String(path)).sort(),
    ).toEqual([
      '/api/conversations/conversation-1',
      '/api/conversations/conversation-1/messages',
      '/api/conversations?archived=false&scope=all&status=%EC%A0%84%EC%B2%B4&limit=30',
    ])
    expect(
      dispatch.mock.calls.map(([action]) => action.type),
    ).toEqual([
      'conversationListLoadSucceeded',
      'thread/loadSucceeded',
      'cardData',
    ])
  })

  it('reloads the open thread for an untargeted inbound message event', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        Response.json(
          String(input).includes('/messages')
            ? { messages: [], nextCursor: null }
            : listResponse,
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const state = {
      ...initialState,
      convs: [conversation],
      selected: conversation.id,
      threads: {
        [conversation.id]: {
          messages: [],
          nextCursor: null,
          loadStatus: 'ready' as const,
          loadingOlder: false,
          loadError: null,
        },
      },
    }
    const dispatch = vi.fn()

    await reloadInboxState(
      state,
      dispatch,
      [inboundEvent()],
      false,
      new AbortController().signal,
    )

    expect(
      fetchMock.mock.calls.map(([path]) => String(path)),
    ).toContain(
      '/api/conversations/conversation-1/messages',
    )
    expect(
      dispatch.mock.calls.map(([action]) => action.type),
    ).toEqual([
      'conversationListLoadSucceeded',
      'thread/loadSucceeded',
    ])
  })
})
