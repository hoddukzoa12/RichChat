import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConversationListResponse,
  ConversationWriteState,
} from '../../../shared/wire/conversation'
import {
  conversationVersionConflict,
  getConversations,
  patchConversation,
} from './conversations'

const RESPONSE: ConversationListResponse = {
  conversations: [
    {
      id: 'conversation-1',
      officeChannel: {
        id: 'office-channel-1',
        label: '업무폰 1',
        value: '01012345678',
      },
      customer: {
        id: 'customer-1',
        name: '김리치',
        company: '리치상사',
        phoneE164: '+821012345678',
      },
      preview: '세금계산서 발급 문의입니다.',
      lastMessageAt: 1_785_233_160_000,
      unreadCount: 2,
      assignees: [{ id: 'user-1', name: '박상담' }],
      status: '미처리',
      label: '긴급',
      archived: false,
      version: 3,
    },
  ],
  nextCursor: 'next-page',
  facets: {
    status: { 전체: 4, 미처리: 2, 처리중: 1, 완료: 1 },
    scope: { all: 4, mine: 2, none: 1 },
    archive: { active: 4, archived: 12 },
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('conversation list endpoint', () => {
  it('serializes cursor filters and returns the wire response unchanged', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(Response.json(RESPONSE)),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const result = await getConversations(
      {
        archived: true,
        scope: 'mine',
        status: '미처리',
        q: '김리치',
        cursor: 'cursor-1',
        limit: 30,
      },
      controller.signal,
    )

    const [path, init] = fetchMock.mock.calls[0]
    const url = new URL(String(path), 'https://richchat.test')
    expect(url.pathname).toBe('/api/conversations')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      archived: 'true',
      scope: 'mine',
      status: '미처리',
      q: '김리치',
      cursor: 'cursor-1',
      limit: '30',
    })
    expect(init).toMatchObject({
      credentials: 'same-origin',
      signal: controller.signal,
    })
    expect(result).toEqual(RESPONSE)
  })

  it('omits undefined optional parameters', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(Response.json(RESPONSE)),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getConversations({})

    expect(fetchMock.mock.calls[0][0]).toBe('/api/conversations')
  })

  it('sends the version and requested fields in a PATCH request', async () => {
    const conversation: ConversationWriteState = {
      id: 'conversation/1',
      status: '처리중',
      label: '부가세',
      archived: true,
      version: 4,
      updatedAt: 1_785_233_160_001,
    }
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(Response.json({ conversation })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await patchConversation('conversation/1', {
      status: '처리중',
      archived: true,
      label: '부가세',
      version: 3,
    })

    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/conversations/conversation%2F1')
    expect(init).toMatchObject({
      credentials: 'same-origin',
      method: 'PATCH',
    })
    expect(new Headers(init?.headers).get('content-type')).toBe(
      'application/json',
    )
    expect(JSON.parse(String(init?.body))).toEqual({
      status: '처리중',
      archived: true,
      label: '부가세',
      version: 3,
    })
    expect(result).toEqual({ conversation })
  })

  it('returns the current server state from a version conflict', async () => {
    const current: ConversationWriteState = {
      id: 'conversation-1',
      status: '완료',
      label: '서버 라벨',
      archived: false,
      version: 7,
      updatedAt: 1_785_233_160_002,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: 'CONFLICT_VERSION',
                message: '다른 사용자가 먼저 대화를 변경했습니다.',
                detail: { conversation: current },
              },
            },
            { status: 409 },
          ),
        ),
      ),
    )

    let failure: unknown
    try {
      await patchConversation('conversation-1', {
        status: '처리중',
        version: 6,
      })
    } catch (error: unknown) {
      failure = error
    }

    expect(conversationVersionConflict(failure)).toEqual(current)
  })
})
