import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventCatchupResponse } from '../../../shared/wire/event'
import { getEvents } from './events'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Event endpoint', () => {
  it('requests catchup from the applied office sequence', async () => {
    const response: EventCatchupResponse = {
      events: [],
      hasMore: false,
      nextCursor: 17,
    }
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json(response)),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getEvents(17)).resolves.toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/events?since=17',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })
})
