import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationMessage } from '../../shared/wire/message'
import type { ThreadMessage } from '../state/thread'
import {
  handleComposerKeyDown,
  MessageBubble,
  MessageComposer,
  restoredScrollTop,
} from './ThreadPanel'
import {
  ImageViewer,
  wrappedViewerIndex,
} from './ImageViewer'

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
    expect(markup).toContain('aria-haspopup="dialog"')
    expect(markup).toContain('사업자등록증.jpg 크게 보기')
    expect(markup).toContain('첨부 파일 받는 중')
    expect(markup).not.toContain('http')
  })

  it('renders accessible image viewer controls with authenticated URLs', () => {
    const markup = renderToStaticMarkup(
      <ImageViewer
        attachments={[
          {
            id: 'attachment/1',
            originalFilename: '사업자등록증.jpg',
            byteSize: 100,
            mimeType: 'image/jpeg',
            downloadStatus: '완료',
            createdAt: 1,
          },
          {
            id: 'attachment/2',
            originalFilename: '영수증.png',
            byteSize: 200,
            mimeType: 'image/png',
            downloadStatus: '완료',
            createdAt: 2,
          },
        ]}
        initialIndex={1}
        onClose={vi.fn()}
      />,
    )

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('이미지 크게 보기 닫기')
    expect(markup).toContain('이전 이미지')
    expect(markup).toContain('다음 이미지')
    expect(markup).toContain(
      'src="/api/attachments/attachment%2F2?mode=inline"',
    )
    expect(markup).toContain(
      'href="/api/attachments/attachment%2F2"',
    )
    expect(markup).not.toContain('http')
  })

  it('wraps image viewer navigation in both directions', () => {
    expect(wrappedViewerIndex(-1, 3)).toBe(2)
    expect(wrappedViewerIndex(3, 3)).toBe(0)
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

  it('renders an accessible multi-image file chooser', () => {
    const markup = renderToStaticMarkup(
      <MessageComposer
        draft=""
        sendError={null}
        onDraftChange={vi.fn()}
        onSend={vi.fn()}
      />,
    )

    expect(markup).toContain('type="file"')
    expect(markup).toContain('accept="image/*,.heic,.heif"')
    expect(markup).toContain('multiple=""')
    expect(markup).toContain('aria-label="이미지 파일 선택"')
    expect(markup).toContain('＋ 파일')
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

  it('does not submit Enter while an IME composition is active', () => {
    const preventDefault = vi.fn()
    const submit = vi.fn()

    handleComposerKeyDown(
      {
        key: 'Enter',
        shiftKey: false,
        nativeEvent: {
          isComposing: true,
          keyCode: 13,
        },
        preventDefault,
      },
      submit,
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('does not submit the legacy IME Enter signal', () => {
    const preventDefault = vi.fn()
    const submit = vi.fn()

    handleComposerKeyDown(
      {
        key: 'Enter',
        shiftKey: false,
        nativeEvent: {
          isComposing: false,
          keyCode: 229,
        },
        preventDefault,
      },
      submit,
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('submits normally after ignoring an IME Enter', () => {
    const preventDefault = vi.fn()
    const submit = vi.fn()

    handleComposerKeyDown(
      {
        key: 'Enter',
        shiftKey: false,
        nativeEvent: {
          isComposing: true,
          keyCode: 229,
        },
        preventDefault,
      },
      submit,
    )
    handleComposerKeyDown(
      {
        key: 'Enter',
        shiftKey: false,
        nativeEvent: {
          isComposing: false,
          keyCode: 13,
        },
        preventDefault,
      },
      submit,
    )

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
  })

  it('submits plain Enter but preserves Shift+Enter', () => {
    const preventDefault = vi.fn()
    const submit = vi.fn()

    handleComposerKeyDown(
      {
        key: 'Enter',
        shiftKey: false,
        nativeEvent: {
          isComposing: false,
          keyCode: 13,
        },
        preventDefault,
      },
      submit,
    )
    handleComposerKeyDown(
      {
        key: 'Enter',
        shiftKey: true,
        nativeEvent: {
          isComposing: false,
          keyCode: 13,
        },
        preventDefault,
      },
      submit,
    )

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
  })

  it('preserves the visible scroll anchor after prepending history', () => {
    expect(
      restoredScrollTop({ height: 1_000, top: 80 }, 1_640),
    ).toBe(720)
  })
})
