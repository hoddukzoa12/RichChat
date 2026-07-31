import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ComposeConversationModal } from './ComposeConversationModal'

describe('Compose conversation modal', () => {
  it('collects only the phone and recipient before opening a thread', () => {
    const markup = renderToStaticMarkup(
      <ComposeConversationModal
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />,
    )

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('새 메시지')
    expect(markup).toContain('보내는 폰')
    expect(markup).toContain('받는 사람')
    expect(markup).toContain('본문은 열린 대화에서 입력합니다')
    expect(markup).not.toContain('<textarea')
  })
})
