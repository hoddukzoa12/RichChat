import type { AttachmentDownloadStatus } from '../../shared/domain'
import { error } from '../http/error'
import type { Route, RouteParams } from '../http/router'
import { requireSession } from '../http/session'

const PRIVATE_ATTACHMENT_HEADERS = {
  'accept-ranges': 'none',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
} as const

const INLINE_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

const DEFAULT_FILENAME = 'attachment'
const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

interface AttachmentRow {
  byte_size: number | null
  download_status: AttachmentDownloadStatus
  mime_type: string | null
  original_filename: string | null
  r2_key: string | null
}

interface AttachmentContext {
  env: Env
  request: Request
  row: AttachmentRow
}

type AttachmentStatusHandler = (
  context: AttachmentContext,
) => Promise<Response> | Response

function secured(response: Response): Response {
  for (const [name, value] of Object.entries(
    PRIVATE_ATTACHMENT_HEADERS,
  )) {
    response.headers.set(name, value)
  }

  return response
}

function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .replace(/[\u0000-\u001f\u007f"\\/]/gu, '_')
    .trim()

  return sanitized && sanitized !== '.' && sanitized !== '..'
    ? sanitized
    : DEFAULT_FILENAME
}

function asciiFilename(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/gu, '_')
  return fallback || DEFAULT_FILENAME
}

function encodeRfc5987(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/gu,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function attachmentDisposition(filename: string): string {
  const safeFilename = sanitizeFilename(filename)

  return [
    `attachment; filename="${asciiFilename(safeFilename)}"`,
    `filename*=UTF-8''${encodeRfc5987(safeFilename)}`,
  ].join('; ')
}

function inlineContentType(mimeType: string | null): string | undefined {
  const normalized = mimeType?.trim().toLowerCase()
  return normalized && INLINE_IMAGE_MIME_TYPES.has(normalized)
    ? normalized
    : undefined
}

async function serveCompleted({
  env,
  request,
  row,
}: AttachmentContext): Promise<Response> {
  if (
    row.r2_key === null ||
    row.original_filename === null ||
    row.mime_type === null ||
    row.byte_size === null
  ) {
    return secured(
      error(
        'INTERNAL_ERROR',
        '첨부 파일 저장 상태가 올바르지 않습니다.',
      ),
    )
  }

  if (request.headers.has('range')) {
    return secured(
      error('BAD_REQUEST', '부분 다운로드를 지원하지 않습니다.'),
    )
  }

  const object = await env.ATTACHMENTS.get(row.r2_key)
  if (object === null) {
    return secured(
      error(
        'INTERNAL_ERROR',
        '저장된 첨부 파일을 찾을 수 없습니다.',
      ),
    )
  }

  const trustedImageType = inlineContentType(row.mime_type)
  const inlineRequested =
    new URL(request.url).searchParams.get('mode') === 'inline'
  const inline = inlineRequested && trustedImageType !== undefined
  const headers = new Headers(PRIVATE_ATTACHMENT_HEADERS)
  headers.set(
    'content-disposition',
    inline
      ? 'inline'
      : attachmentDisposition(row.original_filename),
  )
  headers.set(
    'content-type',
    trustedImageType ?? DEFAULT_CONTENT_TYPE,
  )
  headers.set('content-length', String(object.size))

  return new Response(object.body, { headers })
}

const ATTACHMENT_STATUS_HANDLERS: Record<
  AttachmentDownloadStatus,
  AttachmentStatusHandler
> = {
  대기: () =>
    secured(error('CONFLICT', '첨부 파일을 아직 받는 중입니다.')),
  완료: serveCompleted,
  실패: () =>
    secured(error('GONE', '첨부 파일을 받는 데 실패했습니다.')),
}

async function getAttachment(
  request: Request,
  env: Env,
  params: RouteParams,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return secured(session)

  const row = await env.DB.prepare(
    `SELECT
      original_filename,
      byte_size,
      mime_type,
      r2_key,
      download_status
    FROM message_attachments
    WHERE id = ?
      AND office_id = ?`,
  )
    .bind(params.id, session.officeId)
    .first<AttachmentRow>()

  if (row === null) {
    return secured(error('NOT_FOUND', '첨부 파일을 찾을 수 없습니다.'))
  }

  return ATTACHMENT_STATUS_HANDLERS[row.download_status]({
    env,
    request,
    row,
  })
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/attachments/:id',
    handler: getAttachment,
  },
]
