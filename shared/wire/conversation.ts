import { STATUSES, type Status } from '../domain'
import type { Note } from './note'
import type { Task } from './task'

export const CONVERSATION_SCOPES = ['all', 'mine', 'none'] as const
export const CONVERSATION_ARCHIVE_FILTERS = ['active', 'archived'] as const
export const CONVERSATION_STATUS_FILTERS = ['전체', ...STATUSES] as const

export const CONVERSATION_LIST_DEFAULT_LIMIT = 30
export const CONVERSATION_LIST_MAX_LIMIT = 100

export type ConversationScope = (typeof CONVERSATION_SCOPES)[number]
export type ConversationArchiveFilter =
  (typeof CONVERSATION_ARCHIVE_FILTERS)[number]
export type ConversationStatusFilter =
  (typeof CONVERSATION_STATUS_FILTERS)[number]

export interface ConversationListParams {
  archived?: boolean
  scope?: ConversationScope
  status?: ConversationStatusFilter
  q?: string
  cursor?: string
  limit?: number
}

export interface ConversationListCustomer {
  id: string
  name: string
  company: string
  phoneE164: string
}

export interface ConversationListAssignee {
  id: string
  name: string
}

export interface ConversationOfficeChannel {
  id: string
  label: string
  value: string
}

export interface ConversationListItem {
  id: string
  officeChannel: ConversationOfficeChannel | null
  customer: ConversationListCustomer
  preview: string
  lastMessageAt: number | null
  unreadCount: number
  assignees: ConversationListAssignee[]
  status: Status
  label: string
  archived: boolean
  version: number
}

export interface ConversationListFacets {
  status: Record<ConversationStatusFilter, number>
  scope: Record<ConversationScope, number>
  archive: Record<ConversationArchiveFilter, number>
}

export interface ConversationListResponse {
  conversations: ConversationListItem[]
  nextCursor: string | null
  facets: ConversationListFacets
}

export interface ConversationComposeOptionsResponse {
  phones: ConversationOfficeChannel[]
  customers: ConversationListCustomer[]
}

export type ConversationStartRequest = {
  officeChannelId: string
} & (
  | { customerId: string; phone?: never }
  | { customerId?: never; phone: string }
)

export interface ConversationStartResponse {
  conversationId: string
  customerPhoneE164: string
}

export interface ConversationCustomerField {
  id: string
  key: string
  value: string
  sortOrder: number
}

export interface ConversationCustomer {
  id: string
  name: string
  company: string
  roleTitle: string
  phoneE164: string
  version: number
  fields: ConversationCustomerField[]
}

export interface ConversationAssignee {
  id: string
  name: string
  title: string
}

/**
 * 목록 항목과 분리된 대화 상세 읽기 모델이다.
 * 메시지는 별도 페이지 API에서 가져오므로 이 타입에 포함하지 않는다.
 */
export interface ConversationDetail {
  id: string
  officeChannel: ConversationOfficeChannel | null
  status: Status
  label: string
  archived: boolean
  version: number
  customer: ConversationCustomer
  assignees: ConversationAssignee[]
  tasks: Task[]
  notes: Note[]
}

export interface ConversationDetailResponse {
  conversation: ConversationDetail
}

export interface ConversationWriteState {
  id: string
  status: Status
  label: string
  archived: boolean
  version: number
  updatedAt: number
}

export interface ConversationWriteResponse {
  conversation: ConversationWriteState
}
