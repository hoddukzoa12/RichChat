import type { AttachmentDownloadStatus } from '../domain'

export interface MessageAttachment {
  id: string
  originalFilename: string | null
  byteSize: number | null
  mimeType: string | null
  downloadStatus: AttachmentDownloadStatus
  createdAt: number
}
