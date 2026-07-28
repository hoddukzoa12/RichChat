import { afterEach, describe, expect, it, vi } from 'vitest'
import { markConversationRead } from './reads'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('conversation read endpoint', () => {
  it('asks the server to advance through every current inbound message', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(new Response(null, { status: 204 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await markConversationRead('conversation-1', controller.signal)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conversation-1/read',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
      }),
    )
    const init = fetchMock.mock.calls[0][1]
    expect(new Headers(init?.headers).get('content-type')).toBe(
      'application/json',
    )
    expect(JSON.parse(String(init?.body))).toEqual({
      readInboundCount: Number.MAX_SAFE_INTEGER,
    })
  })
})
