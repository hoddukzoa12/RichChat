import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiRequestError,
  apiMutation,
  apiRequest,
  onUnauthorized,
} from './client'
import {
  customersEndpoint,
  eventsEndpoint,
  messagesEndpoint,
  notesEndpoint,
  officeEndpoint,
  tasksEndpoint,
} from './endpoints'
import { EndpointStubError } from './endpointStub'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API client', () => {
  it('uses same-origin credentials without forging an Origin header', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(Response.json({ ok: true })),
    )
    vi.stubGlobal('fetch', fetchMock)

    await apiRequest('/api/me')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    const init = fetchMock.mock.calls[0][1]
    expect(new Headers(init?.headers).has('origin')).toBe(false)
  })

  it('distinguishes network failures from server failures', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'BAD_REQUEST', message: '입력값을 확인해 주세요.' } },
          { status: 400 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('/api/me')).rejects.toMatchObject({
      kind: 'network',
      status: undefined,
    })
    await expect(apiRequest('/api/me')).rejects.toMatchObject({
      kind: 'server',
      status: 400,
      message: '입력값을 확인해 주세요.',
    })
  })

  it('notifies the authentication gate for every 401 in one place', async () => {
    const listener = vi.fn()
    const stopListening = onUnauthorized(listener)
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' } },
            { status: 401 },
          ),
        ),
      ),
    )

    await expect(apiRequest('/api/messages')).rejects.toBeInstanceOf(
      ApiRequestError,
    )
    expect(listener).toHaveBeenCalledOnce()
    stopListening()
  })

  it('adds a UUID clientKey and requires the server to echo it', async () => {
    const fetchMock = vi.fn((_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        text: string
        clientKey: string
      }
      return Promise.resolve(
        Response.json({ id: 'message-1', clientKey: body.clientKey }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await apiMutation<{ id: string }, { text: string }>(
      '/api/messages',
      {
        method: 'POST',
        body: { text: '안녕하세요' },
      },
    )

    const init = fetchMock.mock.calls[0][1]
    const sent = JSON.parse(String(init?.body)) as {
      text: string
      clientKey: string
    }
    expect(sent.text).toBe('안녕하세요')
    expect(sent.clientKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(result.clientKey).toBe(sent.clientKey)
  })
})

describe('Endpoint stubs', () => {
  it('fails explicitly for every endpoint owned by later slices', () => {
    const stubs = [
      messagesEndpoint,
      customersEndpoint,
      notesEndpoint,
      tasksEndpoint,
      officeEndpoint,
      eventsEndpoint,
    ]

    for (const stub of stubs) {
      expect(stub).toThrow(EndpointStubError)
    }
  })
})
