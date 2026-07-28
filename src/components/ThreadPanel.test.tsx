import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationMessage } from '../../shared/wire/message'
import type { ThreadMessage } from '../state/thread'
import {
  MessageBubble,
  MessageComposer,
  restoredScrollTop,
} from './ThreadPanel'

function message(
  overrides: Partial<ConversationMessage> = {},
): ThreadMessage {
  return {
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
    ...overrides,
  }
}

describe('thread presentation', () => {
  it('renders the stored outbound sender instead of the viewer', () => {
    const markup = renderToStaticMarkup(
      <MessageBubble
        customerInitial="이"
        message={message()}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain('김세무 · 세무사')
    expect(markup).toContain('>김<')
    expect(markup).toContain('>접수<')
    expect(markup).not.toContain('전송 완료')
  })

  it('makes an unidentified inbound sender explicit', () => {
    const markup = renderToStaticMarkup(
      <MessageBubble
        customerInitial="이"
        message={message({
          direction: 'in',
          sender: null,
          deliveryStatus: '수신',
        })}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain('고객 · 개인 발신자 미식별')
    expect(markup).not.toContain('김세무')
  })

  it('shows delivery failure details', () => {
    const markup = renderToStaticMarkup(
      <MessageBubble
        customerInitial="이"
        message={message({
          deliveryStatus: '실패',
          errorText: '수신번호 오류',
        })}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain('>실패<')
    expect(markup).toContain('실패 사유: 수신번호 오류')
  })

  it('renders an image inline and keeps a separate download link', () => {
    const markup = renderToStaticMarkup(
      <MessageBubble
        customerInitial="이"
        message={message({
          attachments: [
            {
              id: 'attachment-1',
              originalFilename: '사업자등록증.jpg',
              byteSize: 100,
              mimeType: 'image/jpeg',
              downloadStatus: '완료',
              createdAt: 1,
            },
            {
              id: 'attachment-2',
              originalFilename: null,
              byteSize: null,
              mimeType: null,
              downloadStatus: '대기',
              createdAt: 2,
            },
          ],
        })}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain(
      'src="/api/attachments/attachment-1?mode=inline"',
    )
    expect(markup).toContain(
      'href="/api/attachments/attachment-1"',
    )
    expect(markup).toContain('다운로드')
    expect(markup).toContain('첨부 파일 받는 중')
    expect(markup).not.toContain('http')
  })

  it('shows byte counters, message types, and pre-send emoji errors', () => {
    const sms = renderToStaticMarkup(
      <MessageComposer
        draft={'가'.repeat(45)}
        sendError={null}
        onDraftChange={vi.fn()}
        onSend={vi.fn()}
      />,
    )
    const lms = renderToStaticMarkup(
      <MessageComposer
        draft={'가'.repeat(46)}
        sendError={null}
        onDraftChange={vi.fn()}
        onSend={vi.fn()}
      />,
    )
    const emoji = renderToStaticMarkup(
      <MessageComposer
        draft="확인 😀"
        sendError={null}
        onDraftChange={vi.fn()}
        onSend={vi.fn()}
      />,
    )

    expect(sms).toContain('90 / 90 byte · SMS')
    expect(lms).toContain('92 / 2,000 byte · LMS')
    expect(emoji).toContain(
      '문자로 보낼 수 없는 이모지가 포함되어 있습니다.',
    )
    expect(emoji).toContain('disabled=""')
  })

  it('maps dedicated server error codes without depending on copy', () => {
    const markup = renderToStaticMarkup(
      <MessageComposer
        draft=""
        sendError={{
          code: 'MSG_ATTACHMENTS_UNSUPPORTED',
          message: '서버 문구는 바뀔 수 있습니다.',
        }}
        onDraftChange={vi.fn()}
        onSend={vi.fn()}
      />,
    )

    expect(markup).toContain(
      '첨부 파일 발송은 아직 지원하지 않습니다.',
    )
    expect(markup).not.toContain('서버 문구는 바뀔 수 있습니다.')
  })

  it('preserves the visible scroll anchor after prepending history', () => {
    expect(
      restoredScrollTop({ height: 1_000, top: 80 }, 1_640),
    ).toBe(720)
  })
})
