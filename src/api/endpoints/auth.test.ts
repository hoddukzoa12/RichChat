import { afterEach, describe, expect, it, vi } from 'vitest'
import { logout } from './auth'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('auth endpoint', () => {
  it('posts logout with same-origin credentials', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(new Response(null, { status: 204 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    await logout()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
      }),
    )
  })
})
