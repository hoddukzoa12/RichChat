import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationListResponse } from '../../../shared/wire/conversation'
import { getConversations } from './conversations'

const RESPONSE: ConversationListResponse = {
  conversations: [
    {
      id: 'conversation-1',
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
})
