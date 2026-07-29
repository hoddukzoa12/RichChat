import {
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { attachmentUrl } from '../api/endpoints/attachments'
import type { MessageAttachment } from '../../shared/wire/message'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function attachmentName(attachment: MessageAttachment): string {
  return attachment.originalFilename ?? '첨부 이미지'
}

export function wrappedViewerIndex(
  index: number,
  attachmentCount: number,
): number {
  if (attachmentCount <= 0) return 0
  return ((index % attachmentCount) + attachmentCount) % attachmentCount
}

export interface ImageViewerProps {
  attachments: MessageAttachment[]
  initialIndex: number
  onClose: () => void
}

export function ImageViewer({
  attachments,
  initialIndex,
  onClose,
}: ImageViewerProps) {
  const [activeIndex, setActiveIndex] = useState(() =>
    wrappedViewerIndex(initialIndex, attachments.length),
  )
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const displayedIndex = wrappedViewerIndex(
    activeIndex,
    attachments.length,
  )
  const activeAttachment = attachments[displayedIndex]
  const hasMultiple = attachments.length > 1

  useEffect(() => {
    const previouslyFocused = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key === 'ArrowLeft' && hasMultiple) {
        event.preventDefault()
        setActiveIndex((index) =>
          wrappedViewerIndex(index - 1, attachments.length),
        )
        return
      }

      if (event.key === 'ArrowRight' && hasMultiple) {
        event.preventDefault()
        setActiveIndex((index) =>
          wrappedViewerIndex(index + 1, attachments.length),
        )
        return
      }

      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          FOCUSABLE_SELECTOR,
        ),
      )
      const first = focusableElements[0]
      const last = focusableElements.at(-1)

      if (!first || !last) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        document.activeElement === last
      ) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus()
      }
    }
  }, [attachments.length, hasMultiple, onClose])

  const move = (offset: number) => {
    setActiveIndex((index) =>
      wrappedViewerIndex(index + offset, attachments.length),
    )
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-keyshortcuts="Escape ArrowLeft ArrowRight"
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex flex-col bg-ink/90 p-3 outline-none sm:p-5"
    >
      <div
        aria-hidden="true"
        data-image-viewer-backdrop=""
        className="absolute inset-0"
        onClick={onClose}
      />

      <div className="relative z-10 flex min-w-0 flex-none items-center gap-2">
        <div className="min-w-0 flex-1 text-white">
          <h2
            id={titleId}
            className="truncate text-sm font-semibold"
          >
            {attachmentName(activeAttachment)}
          </h2>
          <p
            aria-live="polite"
            className="text-xs text-white/70"
          >
            {displayedIndex + 1} / {attachments.length}
          </p>
        </div>
        <a
          href={attachmentUrl(activeAttachment.id)}
          className="flex h-9 flex-none items-center rounded-lg border border-white/30 bg-white/10 px-3 text-sm font-semibold text-white hover:bg-white/20"
        >
          다운로드
        </a>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-white/30 bg-white/10 text-lg text-white hover:bg-white/20"
          aria-label="이미지 크게 보기 닫기"
        >
          ×
        </button>
      </div>

      <div className="pointer-events-none relative z-10 flex min-h-0 flex-1 items-center justify-center py-3">
        {hasMultiple && (
          <button
            type="button"
            onClick={() => move(-1)}
            className="pointer-events-auto absolute left-0 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-ink/70 text-2xl text-white hover:bg-ink"
            aria-label="이전 이미지"
          >
            ‹
          </button>
        )}
        <img
          src={attachmentUrl(activeAttachment.id, 'inline')}
          alt={attachmentName(activeAttachment)}
          className="pointer-events-auto max-h-full max-w-full rounded-lg object-contain shadow-[0_24px_56px_rgba(16,24,40,.3)]"
        />
        {hasMultiple && (
          <button
            type="button"
            onClick={() => move(1)}
            className="pointer-events-auto absolute right-0 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-ink/70 text-2xl text-white hover:bg-ink"
            aria-label="다음 이미지"
          >
            ›
          </button>
        )}
      </div>
    </div>
  )
}
