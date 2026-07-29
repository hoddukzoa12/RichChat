import { OUTBOUND_IMAGE_LIMITS } from '../../shared/attachments'
import type { MessageAttachment } from '../../shared/wire/message'
import type { UploadMessageAttachmentsResponse } from '../../shared/wire/message-send'
import { attachmentObjectKey } from '../attachments'
import { error } from '../http/error'
import { json } from '../http/respond'
import type { Route, RouteParams } from '../http/router'
import { requireSession } from '../http/session'
import { createId, type Clock } from '../lib/ids'

type SupportedImageMimeType = 'image/gif' | 'image/jpeg'

interface PreparedUpload {
  attachment: MessageAttachment
  bytes: ArrayBuffer
  r2Key: string
}

interface UploadDependencies {
  clock?: Clock
  idFactory?: () => string
}

const MIME_TYPE_BY_EXTENSION: Readonly<
  Record<'gif' | 'jpeg' | 'jpg', SupportedImageMimeType>
> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
}

function extension(
  filename: string,
): keyof typeof MIME_TYPE_BY_EXTENSION | null {
  const match = /\.([^.]+)$/u.exec(filename.trim().toLowerCase())
  const value = match?.[1]
  return value && Object.hasOwn(MIME_TYPE_BY_EXTENSION, value)
    ? (value as keyof typeof MIME_TYPE_BY_EXTENSION)
    : null
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
}

function hasGifSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false
  const signature = String.fromCharCode(...bytes.subarray(0, 6))
  return signature === 'GIF87a' || signature === 'GIF89a'
}

const SIGNATURE_CHECK: Record<
  SupportedImageMimeType,
  (bytes: Uint8Array) => boolean
> = {
  'image/gif': hasGifSignature,
  'image/jpeg': hasJpegSignature,
}

async function prepareFile(
  file: File,
  now: number,
  idFactory: () => string,
): Promise<PreparedUpload | Response> {
  if (file.size <= 0 || file.size > OUTBOUND_IMAGE_LIMITS.byteSize) {
    return error(
      'BAD_REQUEST',
      `첨부 이미지는 장당 ${OUTBOUND_IMAGE_LIMITS.byteSize.toLocaleString('ko-KR')}바이트 이하여야 합니다.`,
    )
  }

  const fileExtension = extension(file.name)
  const mimeType = file.type.trim().toLowerCase()
  if (
    fileExtension === null ||
    MIME_TYPE_BY_EXTENSION[fileExtension] !== mimeType
  ) {
    return error(
      'BAD_REQUEST',
      'JPG, JPEG, GIF 이미지만 첨부할 수 있습니다.',
    )
  }

  const bytes = await file.arrayBuffer()
  const supportedMimeType = mimeType as SupportedImageMimeType
  if (!SIGNATURE_CHECK[supportedMimeType](new Uint8Array(bytes))) {
    return error(
      'BAD_REQUEST',
      '첨부 이미지의 실제 파일 형식을 확인할 수 없습니다.',
    )
  }

  const id = idFactory()
  return {
    attachment: {
      id,
      originalFilename: file.name,
      byteSize: file.size,
      mimeType: supportedMimeType,
      downloadStatus: '완료',
      createdAt: now,
    },
    bytes,
    r2Key: attachmentObjectKey(id),
  }
}

async function conversationExists(
  db: D1Database,
  conversationId: string,
  officeId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1
       FROM conversations
       WHERE id = ?
         AND office_id = ?`,
    )
    .bind(conversationId, officeId)
    .first()

  return row !== null
}

async function discardObjects(
  bucket: R2Bucket,
  uploads: PreparedUpload[],
): Promise<void> {
  await Promise.allSettled(
    uploads.map((upload) => bucket.delete(upload.r2Key)),
  )
}

function createMessageAttachmentUploadRoutes(
  dependencies: UploadDependencies = {},
): Route[] {
  const clock = dependencies.clock ?? Date.now
  const idFactory = dependencies.idFactory ?? createId

  async function uploadAttachments(
    request: Request,
    env: Env,
    params: RouteParams,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session

    if (!(await conversationExists(env.DB, params.id, session.officeId))) {
      return error('NOT_FOUND', '대화를 찾을 수 없습니다.')
    }

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return error('BAD_REQUEST', '첨부 업로드 형식을 확인해 주세요.')
    }

    const values = form.getAll('files')
    if (
      values.length < 1 ||
      values.length > OUTBOUND_IMAGE_LIMITS.count ||
      values.some((value) => !(value instanceof File))
    ) {
      return error(
        'BAD_REQUEST',
        `첨부 이미지는 한 번에 최대 ${OUTBOUND_IMAGE_LIMITS.count}장까지 올릴 수 있습니다.`,
      )
    }

    const now = clock()
    const uploads: PreparedUpload[] = []
    for (const value of values) {
      const prepared = await prepareFile(value as File, now, idFactory)
      if (prepared instanceof Response) return prepared
      uploads.push(prepared)
    }

    try {
      await Promise.all(
        uploads.map((upload) =>
          env.ATTACHMENTS.put(upload.r2Key, upload.bytes, {
            httpMetadata: {
              contentType: upload.attachment.mimeType ?? undefined,
            },
          }),
        ),
      )
      await env.DB.batch(
        uploads.map((upload) =>
          env.DB.prepare(
            `INSERT INTO outbound_attachment_uploads (
               id, conversation_id, original_filename, byte_size, mime_type,
               r2_key, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            upload.attachment.id,
            params.id,
            upload.attachment.originalFilename,
            upload.attachment.byteSize,
            upload.attachment.mimeType,
            upload.r2Key,
            upload.attachment.createdAt,
          ),
        ),
      )
    } catch {
      await discardObjects(env.ATTACHMENTS, uploads)
      return error('INTERNAL_ERROR', '첨부 이미지를 저장하지 못했습니다.')
    }

    return json(
      {
        attachments: uploads.map(({ attachment }) => attachment),
      } satisfies UploadMessageAttachmentsResponse,
      { status: 201 },
    )
  }

  return [
    {
      method: 'POST',
      path: '/api/conversations/:id/attachments',
      handler: uploadAttachments,
    },
  ]
}

export const routes = createMessageAttachmentUploadRoutes()
