import type { Status, TaskKind } from '../domain'

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

export interface ConversationTask {
  id: string
  name: string
  sub: string
  kind: TaskKind
  sortOrder: number
  createdById: string
  createdAt: number
  updatedAt: number
}

export interface ConversationNote {
  id: string
  authorId: string
  authorName: string
  authorTitle: string
  body: string
  createdAt: number
  updatedAt: number
}

/**
 * 목록 항목과 분리된 대화 상세 읽기 모델이다.
 * 메시지는 별도 페이지 API에서 가져오므로 이 타입에 포함하지 않는다.
 */
export interface ConversationDetail {
  id: string
  status: Status
  label: string
  archived: boolean
  version: number
  customer: ConversationCustomer
  assignees: ConversationAssignee[]
  tasks: ConversationTask[]
  notes: ConversationNote[]
}

export interface ConversationDetailResponse {
  conversation: ConversationDetail
}
