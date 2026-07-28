import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '../../shared/wire/message'
import {
  composerMetrics,
  initialThreadState,
  mergeThreadMessages,
  threadFor,
  threadSliceReducer,
  type ThreadMessage,
  type ThreadState,
} from './thread'

function message(
  id: string,
  occurredAt: number,
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id,
    direction: 'in',
    channel: 'SMS',
    title: null,
    body: id,
    sender: null,
    occurredAt,
    deliveryStatus: '수신',
    resultCode: null,
    deliveredAt: null,
    errorText: null,
    attachments: [],
    ...overrides,
  }
}

function freshState(): ThreadState {
  return {
    ...initialThreadState,
    threads: {},
  }
}

describe('thread state', () => {
  it('counts EUC-KR bytes and exposes the SMS to LMS boundary', () => {
    const fortyFiveKorean = '가'.repeat(45)
    const fortySixKorean = '가'.repeat(46)

    expect(composerMetrics(fortyFiveKorean)).toMatchObject({
      byteLength: 90,
      limit: 90,
      messageType: 'SMS',
      issue: null,
    })
    expect(composerMetrics(fortySixKorean)).toMatchObject({
      byteLength: 92,
      limit: 2000,
      messageType: 'LMS',
      issue: null,
    })
  })

  it('rejects emoji before a send starts', () => {
    expect(composerMetrics('확인했습니다 😀')).toMatchObject({
      issue: 'MSG_EMOJI_UNSUPPORTED',
    })
  })

  it('reconciles optimistic sends by clientKey before id', () => {
    const optimistic: ThreadMessage = {
      ...message('optimistic:key-1', 10, {
        direction: 'out',
        sender: { id: 'user-1', name: '김세무', title: '세무사' },
        deliveryStatus: '대기',
      }),
      clientKey: 'key-1',
      requestState: 'sending',
    }
    const accepted: ThreadMessage = {
      ...message('server-message-1', 10, {
        direction: 'out',
        sender: { id: 'user-1', name: '김세무', title: '세무사' },
        deliveryStatus: '접수',
      }),
      clientKey: 'key-1',
      requestState: null,
    }

    const merged = mergeThreadMessages(
      [optimistic],
      [accepted],
      'append',
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'server-message-1',
      clientKey: 'key-1',
      deliveryStatus: '접수',
    })
  })

  it('keeps one bubble when the same clientKey is retried', () => {
    const sender = {
      id: 'user-1',
      name: '김세무',
      title: '세무사',
    }
    const started = {
      type: 'thread/sendStarted' as const,
      conversationId: 'conversation-1',
      clientKey: 'key-1',
      body: '확인했습니다.',
      occurredAt: 10,
      sender,
    }

    let state = threadSliceReducer(freshState(), started)
    state = threadSliceReducer(state, {
      type: 'thread/sendFailed',
      conversationId: 'conversation-1',
      clientKey: 'key-1',
      error: { message: '네트워크 연결을 확인해 주세요.' },
    })
    state = threadSliceReducer(state, {
      type: 'thread/draftChanged',
      value: '작성 중인 다른 답장',
    })
    state = threadSliceReducer(state, {
      type: 'thread/retryStarted',
      conversationId: 'conversation-1',
      clientKey: 'key-1',
    })

    expect(threadFor(state, 'conversation-1').messages).toHaveLength(1)
    expect(
      threadFor(state, 'conversation-1').messages[0],
    ).toMatchObject({
      clientKey: 'key-1',
      requestState: 'sending',
    })
    expect(state.draft).toBe('작성 중인 다른 답장')
    expect(state.composerError).toBeNull()
  })

  it('prepends ascending older pages without duplicate ids', () => {
    let state = threadSliceReducer(freshState(), {
      type: 'thread/loadSucceeded',
      conversationId: 'conversation-1',
      messages: [message('message-3', 3), message('message-4', 4)],
      nextCursor: 'cursor-1',
      older: false,
    })
    state = threadSliceReducer(state, {
      type: 'thread/loadSucceeded',
      conversationId: 'conversation-1',
      messages: [
        message('message-1', 1),
        message('message-2', 2),
        message('message-3', 3),
      ],
      nextCursor: null,
      older: true,
    })

    expect(
      threadFor(state, 'conversation-1').messages.map(
        (item) => item.id,
      ),
    ).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ])
  })
})
