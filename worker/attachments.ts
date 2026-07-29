import type { AttachmentDownloadStatus } from '../shared/domain'
import type { MessageAttachment } from '../shared/wire/message'

interface AttachmentRow {
  id: string
  message_id: string
  original_filename: string | null
  byte_size: number | null
  mime_type: string | null
  download_status: AttachmentDownloadStatus
  created_at: number
}

export function attachmentObjectKey(attachmentId: string): string {
  return `attachments/${attachmentId}`
}

export async function loadMessageAttachments(
  db: D1Database,
  officeId: string,
  messageIds: string[],
): Promise<Map<string, MessageAttachment[]>> {
  const byMessage = new Map<string, MessageAttachment[]>()
  for (const messageId of messageIds) byMessage.set(messageId, [])
  if (messageIds.length === 0) return byMessage

  const placeholders = messageIds.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT
        id,
        message_id,
        original_filename,
        byte_size,
        mime_type,
        download_status,
        created_at
      FROM message_attachments
      WHERE office_id = ?
        AND message_id IN (${placeholders})
      ORDER BY message_id, content_index, created_at, id`,
    )
    .bind(officeId, ...messageIds)
    .all<AttachmentRow>()

  for (const row of results) {
    byMessage.get(row.message_id)?.push({
      id: row.id,
      originalFilename: row.original_filename,
      byteSize: row.byte_size,
      mimeType: row.mime_type,
      downloadStatus: row.download_status,
      createdAt: row.created_at,
    })
  }

  return byMessage
}
