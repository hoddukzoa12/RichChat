import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMessage } from '../../../shared/wire/message'
import { ApiRequestError } from '../client'
import { attachmentUrl } from './attachments'
import {
  getConversationMessages,
  sendConversationMessage,
} from './messages'

const MESSAGE: ConversationMessage = {
  id: 'message-1',
  direction: 'out',
  channel: 'SMS',
  title: null,
  body: '확인했습니다.',
  sender: {
    id: 'user-kim',
    name: '김세무',
    title: '세무사',
  },
  occurredAt: 1_722_140_760_000,
  deliveryStatus: '접수',
  resultCode: null,
  deliveredAt: null,
  errorText: null,
  attachments: [],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('message endpoints', () => {
  it('requests older pages with the opaque cursor unchanged', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({ messages: [MESSAGE], nextCursor: null }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getConversationMessages('conversation/1', {
      before: 'opaque+/=cursor',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conversation%2F1/messages?before=opaque%2B%2F%3Dcursor',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('reuses the caller clientKey for retries', async () => {
    const clientKey = 'client-key-1'
    const fetchMock = vi.fn((_path: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        clientKey: string
      }
      return Promise.resolve(
        Response.json({
          clientKey: request.clientKey,
          message: MESSAGE,
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const request = { clientKey, body: '확인했습니다.' }
    await sendConversationMessage('conversation-1', request)
    await sendConversationMessage('conversation-1', request)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      const sent = JSON.parse(String(call[1]?.body)) as {
        clientKey: string
      }
      expect(sent.clientKey).toBe(clientKey)
    }
  })

  it('rejects a response that does not echo the clientKey', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            clientKey: 'different-key',
            message: MESSAGE,
          }),
        ),
      ),
    )

    await expect(
      sendConversationMessage('conversation-1', {
        clientKey: 'client-key-1',
        body: '확인했습니다.',
      }),
    ).rejects.toBeInstanceOf(ApiRequestError)
  })

  it('builds only authenticated same-origin attachment URLs', () => {
    expect(attachmentUrl('attachment/1', 'inline')).toBe(
      '/api/attachments/attachment%2F1?mode=inline',
    )
    expect(attachmentUrl('attachment/1')).toBe(
      '/api/attachments/attachment%2F1',
    )
  })
})
