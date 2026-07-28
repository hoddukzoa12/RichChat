import type { ConversationMessage } from './message'

export interface SendMessageRequest {
  clientKey: string
  body: string
  attachments?: unknown[]
}

export interface SendMessageResponse {
  clientKey: string
  message: ConversationMessage
}
