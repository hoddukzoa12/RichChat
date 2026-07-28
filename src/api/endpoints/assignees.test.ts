import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assignConversation,
  unassignConversation,
} from './assignees'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('conversation assignee endpoints', () => {
  it('uses an explicit idempotent assignment direction', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    await assignConversation('conversation/1', 'user/1')
    await unassignConversation('conversation/1', 'user/1')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/conversations/conversation%2F1/assignees/user%2F1',
      expect.objectContaining({
        credentials: 'same-origin',
        method: 'POST',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/conversations/conversation%2F1/assignees/user%2F1',
      expect.objectContaining({
        credentials: 'same-origin',
        method: 'DELETE',
      }),
    )
  })
})
