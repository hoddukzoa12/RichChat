import type {
  ConversationMessage,
  MessageAttachment,
} from './message'

export interface SendMessageAttachment {
  id: string
}

export interface SendMessageRequest {
  clientKey: string
  body: string
  attachments?: SendMessageAttachment[]
}

export interface SendMessageResponse {
  clientKey: string
  message: ConversationMessage
}

export interface UploadMessageAttachmentsResponse {
  attachments: MessageAttachment[]
}
