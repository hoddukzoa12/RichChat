import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import { attachmentUrl } from '../api/endpoints/attachments'
import {
  COMPOSE_IMAGE_LIMITS,
  imageSelectionError,
  prepareComposeImage,
} from '../lib/composeImage'
import {
  composerMetrics,
  type ComposerIssueCode,
  type ConversationThread,
  type ThreadFailure,
  type ThreadMessage,
} from '../state/thread'
import { DELIVERY_STATUS_BADGE } from '../theme'
import { LMS_MAX_BYTES } from '../../shared/sms'
import { initialOf } from '../../shared/text'
import type { MessageAttachment } from '../../shared/wire/message'
import { ImageViewer } from './ImageViewer'

const INLINE_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

type DedicatedSendErrorCode =
  | ComposerIssueCode
  | 'MSG_ATTACHMENTS_UNSUPPORTED'

const SEND_ERROR_COPY: Record<DedicatedSendErrorCode, string> = {
  MSG_EMOJI_UNSUPPORTED:
    '문자로 보낼 수 없는 이모지가 포함되어 있습니다.',
  MSG_TOO_LONG: '문자 메시지는 2,000 byte를 넘을 수 없습니다.',
  MSG_ATTACHMENTS_UNSUPPORTED:
    '첨부 파일 발송은 아직 지원하지 않습니다.',
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(timestamp)
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(timestamp)
}

function dateKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function isInlineImage(attachment: MessageAttachment): boolean {
  return (
    attachment.downloadStatus === '완료' &&
    attachment.mimeType !== null &&
    INLINE_IMAGE_MIME_TYPES.has(attachment.mimeType.toLowerCase())
  )
}

function attachmentName(attachment: MessageAttachment): string {
  return attachment.originalFilename ?? '첨부 파일'
}

export function MessageAttachmentView({
  attachment,
  onOpen,
}: {
  attachment: MessageAttachment
  onOpen: () => void
}) {
  if (attachment.downloadStatus === '대기') {
    return (
      <div className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-ink-500">
        첨부 파일 받는 중
      </div>
    )
  }

  if (attachment.downloadStatus === '실패') {
    return (
      <div className="mt-2 rounded-lg bg-open-bg px-3 py-2 text-xs text-open-fg">
        첨부 파일 받기 실패
      </div>
    )
  }

  const name = attachmentName(attachment)
  return (
    <div className="mt-2 min-w-[190px] overflow-hidden rounded-lg bg-white/90 text-ink">
      {isInlineImage(attachment) && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${name} 크게 보기`}
          aria-haspopup="dialog"
          className="block w-full cursor-zoom-in bg-fill"
        >
          <img
            src={attachmentUrl(attachment.id, 'inline')}
            alt={name}
            className="pointer-events-none max-h-64 w-full object-contain"
          />
        </button>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs">{name}</span>
        <a
          href={attachmentUrl(attachment.id)}
          className="flex-none rounded-md border border-line px-2 py-1 text-xs font-semibold text-brand"
        >
          다운로드
        </a>
      </div>
    </div>
  )
}

function outboundSenderLabel(message: ThreadMessage): string {
  if (!message.sender) return '발신자 정보 없음'
  return message.sender.title
    ? `${message.sender.name} · ${message.sender.title}`
    : message.sender.name
}

export function MessageBubble({
  customerInitial,
  message,
  onRetry,
}: {
  customerInitial: string
  message: ThreadMessage
  onRetry: (clientKey: string) => void
}) {
  const inbound = message.direction === 'in'
  const imageAttachments = message.attachments.filter(isInlineImage)
  const [viewerAttachmentId, setViewerAttachmentId] = useState<
    string | null
  >(null)
  const viewerIndex = imageAttachments.findIndex(
    (attachment) => attachment.id === viewerAttachmentId,
  )
  const closeViewer = useCallback(() => {
    setViewerAttachmentId(null)
  }, [])
  const senderInitial = inbound
    ? customerInitial
    : initialOf(message.sender?.name ?? '') || '?'
  const retryClientKey = message.clientKey

  return (
    <div
      className={`flex max-w-[72%] gap-2.5 ${
        inbound ? '' : 'self-end flex-row-reverse'
      }`}
    >
      <div
        className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-xs font-bold ${
          inbound
            ? 'bg-brand-200 text-brand-text'
            : 'bg-ink text-white'
        }`}
        aria-label={
          inbound
            ? '고객 발신자'
            : outboundSenderLabel(message)
        }
      >
        {senderInitial}
      </div>

      <div
        className={`flex min-w-0 flex-col gap-1 ${
          inbound ? 'items-start' : 'items-end'
        }`}
      >
        <span className="px-0.5 text-[11.5px] text-ink-400">
          {inbound
            ? '고객 · 개인 발신자 미식별'
            : outboundSenderLabel(message)}
        </span>
        <div
          className={`max-w-full px-[15px] py-[11px] text-[14.5px] whitespace-pre-wrap ${
            inbound
              ? 'rounded-[4px_14px_14px_14px] bg-fill text-ink'
              : 'rounded-[14px_4px_14px_14px] bg-brand text-white'
          }`}
        >
          {message.title && (
            <strong className="mb-1 block">{message.title}</strong>
          )}
          {message.body}
          {message.attachments.map((attachment) => (
            <MessageAttachmentView
              key={attachment.id}
              attachment={attachment}
              onOpen={() => setViewerAttachmentId(attachment.id)}
            />
          ))}
        </div>

        <div
          className={`flex flex-wrap items-center gap-1 px-0.5 text-[11.5px] text-ink-400 ${
            inbound ? '' : 'justify-end'
          }`}
        >
          <span
            className={`rounded px-1.5 py-0.5 font-semibold ${
              DELIVERY_STATUS_BADGE[message.deliveryStatus]
            }`}
          >
            {message.deliveryStatus}
          </span>
          {message.direction === 'out' && (
            <span>{message.channel}</span>
          )}
          <span>· {formatTime(message.occurredAt)}</span>
          {message.requestState === 'sending' && <span>· 요청 중</span>}
        </div>

        {message.deliveryStatus === '실패' && message.errorText && (
          <div className="max-w-full rounded-md bg-open-bg px-2 py-1 text-xs text-open-fg">
            실패 사유: {message.errorText}
          </div>
        )}

        {message.requestState === 'failed' && (
          <div className="flex max-w-full items-center gap-2 rounded-md bg-open-bg px-2 py-1 text-xs text-open-fg">
            <span>
              {message.requestError?.message ?? '발송 요청에 실패했습니다.'}
            </span>
            {retryClientKey && (
              <button
                type="button"
                className="flex-none font-bold underline"
                onClick={() => onRetry(retryClientKey)}
              >
                다시 시도
              </button>
            )}
          </div>
        )}
      </div>
      {viewerIndex >= 0 && (
        <ImageViewer
          attachments={imageAttachments}
          initialIndex={viewerIndex}
          onClose={closeViewer}
        />
      )}
    </div>
  )
}

function DateDivider({ timestamp }: { timestamp: number }) {
  return (
    <div className="flex items-center gap-3 text-[12.5px] text-ink-400">
      <div className="h-px flex-1 bg-line" />
      {formatDate(timestamp)}
      <div className="h-px flex-1 bg-line" />
    </div>
  )
}

export interface MessageThreadProps {
  conversationId: string
  customerInitial: string
  thread: ConversationThread
  onLoadOlder: () => Promise<void> | void
  onReload: () => Promise<void> | void
  onRetry: (clientKey: string) => void
}

interface ScrollAnchor {
  height: number
  top: number
}

export function restoredScrollTop(
  anchor: ScrollAnchor,
  nextHeight: number,
): number {
  return anchor.top + (nextHeight - anchor.height)
}

export function MessageThread({
  conversationId,
  customerInitial,
  thread,
  onLoadOlder,
  onReload,
  onRetry,
}: MessageThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollAnchorRef = useRef<ScrollAnchor | null>(null)
  const requestingOlderRef = useRef(false)
  const previousConversationRef = useRef('')
  const previousLastIdRef = useRef<string | undefined>(undefined)
  const lastId = thread.messages.at(-1)?.id

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return

    const anchor = scrollAnchorRef.current
    if (anchor && !thread.loadingOlder) {
      scroll.scrollTop = restoredScrollTop(
        anchor,
        scroll.scrollHeight,
      )
      scrollAnchorRef.current = null
    } else if (
      previousConversationRef.current !== conversationId ||
      previousLastIdRef.current !== lastId
    ) {
      scroll.scrollTop = scroll.scrollHeight
    }

    previousConversationRef.current = conversationId
    previousLastIdRef.current = lastId
  }, [
    conversationId,
    lastId,
    thread.loadingOlder,
    thread.messages,
  ])

  const loadOlder = () => {
    const scroll = scrollRef.current
    if (
      !scroll ||
      !thread.nextCursor ||
      thread.loadingOlder ||
      requestingOlderRef.current
    ) {
      return
    }

    scrollAnchorRef.current = {
      height: scroll.scrollHeight,
      top: scroll.scrollTop,
    }
    requestingOlderRef.current = true
    Promise.resolve(onLoadOlder()).finally(() => {
      requestingOlderRef.current = false
    })
  }

  if (thread.loadStatus === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface text-sm text-ink-400">
        메시지를 불러오는 중입니다.
      </div>
    )
  }

  if (thread.loadStatus === 'failed') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-surface text-sm text-open-fg">
        <span>{thread.loadError ?? '메시지를 불러오지 못했습니다.'}</span>
        <button
          type="button"
          className="rounded-md border border-open-fg px-3 py-1 font-semibold"
          onClick={() => void onReload()}
        >
          다시 불러오기
        </button>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        if (event.currentTarget.scrollTop <= 48) loadOlder()
      }}
      className="flex flex-1 flex-col gap-4 overflow-y-auto bg-surface px-[26px] py-[22px]"
    >
      {thread.loadingOlder && (
        <div className="text-center text-xs text-ink-400">
          이전 메시지를 불러오는 중입니다.
        </div>
      )}
      {thread.loadError && !thread.loadingOlder && (
        <button
          type="button"
          className="self-center rounded-md border border-open-fg px-3 py-1 text-xs font-semibold text-open-fg"
          onClick={loadOlder}
        >
          이전 메시지 다시 불러오기
        </button>
      )}

      {thread.messages.map((message, index) => {
        const previous = thread.messages[index - 1]
        const showDate =
          !previous ||
          dateKey(previous.occurredAt) !== dateKey(message.occurredAt)

        return (
          <div key={`${message.id}:${message.clientKey ?? ''}`} className="contents">
            {showDate && <DateDivider timestamp={message.occurredAt} />}
            <MessageBubble
              customerInitial={customerInitial}
              message={message}
              onRetry={onRetry}
            />
          </div>
        )
      })}

      {thread.messages.length === 0 && thread.loadStatus === 'ready' && (
        <div className="m-auto text-sm text-ink-400">
          아직 메시지가 없습니다.
        </div>
      )}
    </div>
  )
}

function failureMessage(failure: ThreadFailure | null): string | null {
  if (!failure) return null
  if (
    failure.code === 'MSG_EMOJI_UNSUPPORTED' ||
    failure.code === 'MSG_TOO_LONG' ||
    failure.code === 'MSG_ATTACHMENTS_UNSUPPORTED'
  ) {
    return SEND_ERROR_COPY[failure.code]
  }
  return failure.message
}

export interface MessageComposerProps {
  draft: string
  sendError: ThreadFailure | null
  sending?: boolean
  onDraftChange: (value: string) => void
  onSend: () => void
}

interface ConvertingComposerImage {
  id: string
  originalName: string
  status: 'converting'
}

interface ReadyComposerImage {
  id: string
  originalName: string
  status: 'ready'
  file: File
  previewUrl: string
  width: number
  height: number
}

type ComposerImage = ConvertingComposerImage | ReadyComposerImage

function composerImageId(): string {
  return crypto.randomUUID()
}

function imageLimitMessage(rejectedCount: number): string {
  return rejectedCount === 1
    ? '이미지는 최대 3장까지 첨부할 수 있습니다. 4장째 이미지는 추가하지 않았습니다.'
    : `이미지는 최대 3장까지 첨부할 수 있습니다. ${rejectedCount}장은 추가하지 않았습니다.`
}

export function MessageComposer({
  draft,
  sendError,
  sending = false,
  onDraftChange,
  onSend,
}: MessageComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const activeImageIdsRef = useRef(new Set<string>())
  const objectUrlsRef = useRef(new Set<string>())
  const [images, setImages] = useState<ComposerImage[]>([])
  const [selectionErrors, setSelectionErrors] = useState<string[]>([])
  const [attachmentSendError, setAttachmentSendError] = useState<
    string | null
  >(null)
  const metrics = composerMetrics(draft)
  const localError = metrics.issue
    ? SEND_ERROR_COPY[metrics.issue]
    : null
  const error =
    localError ??
    attachmentSendError ??
    failureMessage(sendError)
  const readyImages = images.filter(
    (image): image is ReadyComposerImage =>
      image.status === 'ready',
  )
  const converting = images.some(
    (image) => image.status === 'converting',
  )
  const hasImages = images.length > 0
  const canSend =
    (draft.trim().length > 0 || readyImages.length > 0) &&
    metrics.issue === null &&
    !sending &&
    !converting

  useEffect(
    () => () => {
      activeImageIdsRef.current.clear()
      for (const objectUrl of objectUrlsRef.current) {
        URL.revokeObjectURL(objectUrl)
      }
      objectUrlsRef.current.clear()
    },
    [],
  )

  const submit = () => {
    if (!canSend) return
    if (readyImages.length > 0) {
      // 서버 업로드가 열리기 전 텍스트만 따로 발송되는 사고를 막는다.
      setAttachmentSendError(
        SEND_ERROR_COPY.MSG_ATTACHMENTS_UNSUPPORTED,
      )
      return
    }
    onSend()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    submit()
  }

  const typeLabel = hasImages
    ? metrics.messageType === 'TOO_LONG'
      ? 'MMS 본문 한도 초과'
      : 'MMS'
    : metrics.messageType === 'TOO_LONG'
      ? 'LMS 한도 초과'
      : metrics.messageType
  const byteLimit = hasImages ? LMS_MAX_BYTES : metrics.limit

  const chooseFiles = () => {
    inputRef.current?.click()
  }

  const addSelectedFiles = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const selectedFiles = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    setAttachmentSendError(null)

    const candidates: File[] = []
    const errors: string[] = []
    for (const file of selectedFiles) {
      const validationError = imageSelectionError(file)
      if (validationError) {
        errors.push(validationError)
      } else {
        candidates.push(file)
      }
    }

    const available =
      COMPOSE_IMAGE_LIMITS.count - activeImageIdsRef.current.size
    const accepted = candidates.slice(0, Math.max(0, available))
    const rejectedCount = candidates.length - accepted.length
    if (rejectedCount > 0) {
      errors.push(imageLimitMessage(rejectedCount))
    }
    setSelectionErrors(errors)

    const additions = accepted.map((file) => {
      const id = composerImageId()
      activeImageIdsRef.current.add(id)
      return {
        file,
        image: {
          id,
          originalName: file.name,
          status: 'converting' as const,
        },
      }
    })
    setImages((current) => [
      ...current,
      ...additions.map(({ image }) => image),
    ])

    for (const { file, image } of additions) {
      void prepareComposeImage(file)
        .then((prepared) => {
          if (!activeImageIdsRef.current.has(image.id)) return
          const previewUrl = URL.createObjectURL(prepared.file)
          objectUrlsRef.current.add(previewUrl)
          setImages((current) =>
            current.map((candidate) =>
              candidate.id === image.id
                ? {
                    ...image,
                    status: 'ready',
                    file: prepared.file,
                    previewUrl,
                    width: prepared.width,
                    height: prepared.height,
                  }
                : candidate,
            ),
          )
        })
        .catch((conversionError: unknown) => {
          activeImageIdsRef.current.delete(image.id)
          setImages((current) =>
            current.filter(
              (candidate) => candidate.id !== image.id,
            ),
          )
          setSelectionErrors((current) => [
            ...current,
            conversionError instanceof Error
              ? conversionError.message
              : `${file.name} 이미지를 읽거나 변환할 수 없습니다.`,
          ])
        })
    }
  }

  const removeImage = (image: ComposerImage) => {
    activeImageIdsRef.current.delete(image.id)
    if (image.status === 'ready') {
      URL.revokeObjectURL(image.previewUrl)
      objectUrlsRef.current.delete(image.previewUrl)
    }
    setImages((current) =>
      current.filter((candidate) => candidate.id !== image.id),
    )
    setSelectionErrors([])
    setAttachmentSendError(null)
  }

  return (
    <div className="flex-none border-t border-line bg-white px-5 pt-3.5 pb-4">
      <div className="rounded-xl border-[1.5px] border-line-strong bg-white shadow-[0_1px_2px_rgba(16,24,40,.04)] focus-within:border-brand">
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="메시지를 입력하세요 (Enter 전송 · Shift+Enter 줄바꿈)"
          className="h-[76px] w-full resize-none border-none bg-transparent px-[15px] pt-3.5 pb-1.5 font-sans text-[14.5px] leading-[1.55] text-ink outline-none"
        />
        {images.length > 0 && (
          <ul
            aria-label="첨부 이미지"
            className="grid grid-cols-3 gap-2 px-3 pb-2"
          >
            {images.map((image) => (
              <li
                key={image.id}
                className="relative min-w-0 overflow-hidden rounded-lg border border-line bg-fill"
                data-image-status={image.status}
                {...(image.status === 'ready'
                  ? {
                      'data-image-byte-size': image.file.size,
                      'data-image-width': image.width,
                      'data-image-height': image.height,
                    }
                  : {})}
              >
                {image.status === 'converting' ? (
                  <div
                    className="flex aspect-[4/3] items-center justify-center px-2 text-center text-xs font-medium text-ink-500"
                    aria-live="polite"
                  >
                    JPEG로 변환 중…
                  </div>
                ) : (
                  <>
                    <img
                      src={image.previewUrl}
                      alt={`${image.originalName} 미리보기`}
                      className="aspect-[4/3] w-full bg-white object-contain"
                    />
                    <div className="min-w-0 px-2 py-1.5">
                      <div className="truncate text-[11px] text-ink-600">
                        {image.originalName}
                      </div>
                      <div className="truncate text-[10px] text-ink-400">
                        {image.width} × {image.height} ·{' '}
                        {image.file.size.toLocaleString('ko-KR')} byte
                      </div>
                    </div>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => removeImage(image)}
                  aria-label={`${image.originalName} 첨부에서 제거`}
                  className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-sm font-bold text-white hover:bg-black/80"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {selectionErrors.length > 0 && (
          <div
            role="alert"
            className="mx-3 mb-2 rounded-md bg-open-bg px-3 py-2 text-xs text-open-fg"
          >
            {selectionErrors.map((message, index) => (
              <div key={`${index}:${message}`}>{message}</div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 px-3 pb-[11px]">
          <input
            ref={inputRef}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            onChange={addSelectedFiles}
            className="sr-only"
            aria-label="이미지 파일 선택"
          />
          <button
            type="button"
            onClick={chooseFiles}
            disabled={sending}
            className="flex h-[30px] items-center rounded-lg border border-line px-[11px] text-[13px] font-medium text-ink-600 hover:border-brand hover:text-brand"
          >
            ＋ 파일
          </button>
          <span className="ml-0.5 text-xs text-ink-400">
            {metrics.byteLength.toLocaleString('ko-KR')} /{' '}
            {byteLimit.toLocaleString('ko-KR')} byte · {typeLabel}
          </span>
          <button
            type="button"
            disabled={!canSend}
            onClick={submit}
            className={`ml-auto flex h-[34px] items-center rounded-[9px] px-5 text-sm font-semibold text-white ${
              canSend
                ? 'cursor-pointer bg-brand hover:bg-brand-hover'
                : 'cursor-default bg-line-soft'
            }`}
          >
            {sending ? '요청 중' : '전송'}
          </button>
        </div>
        {error && (
          <div
            role="alert"
            className="border-t border-open-bg px-[15px] py-2 text-xs text-open-fg"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
