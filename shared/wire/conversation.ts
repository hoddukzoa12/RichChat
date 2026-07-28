import { STATUSES, type Status } from '../domain'

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

export interface ConversationListItem {
  id: string
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
