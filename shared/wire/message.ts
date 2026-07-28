import type {
  AttachmentDownloadStatus,
  DeliveryStatus,
  Direction,
  SendChannel,
} from '../domain'

export const MESSAGE_PAGE_SIZE = 50

export interface MessageAttachment {
  id: string
  originalFilename: string | null
  byteSize: number | null
  mimeType: string | null
  downloadStatus: AttachmentDownloadStatus
  createdAt: number
}

export interface MessageSender {
  id: string
  name: string
  title: string
}

export interface ConversationMessage {
  id: string
  direction: Direction
  channel: SendChannel
  title: string | null
  body: string
  /**
   * 인바운드는 개인 발신자를 식별할 수 없어 null이고,
   * 아웃바운드는 실제 발송한 사무소 사용자다.
   */
  sender: MessageSender | null
  occurredAt: number
  deliveryStatus: DeliveryStatus
  resultCode: string | null
  deliveredAt: number | null
  errorText: string | null
  attachments: MessageAttachment[]
}

export interface MessagePageResponse {
  messages: ConversationMessage[]
  nextCursor: string | null
}
