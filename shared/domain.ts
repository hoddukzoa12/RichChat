export const STATUSES = ['미처리', '처리중', '완료'] as const
export const TASK_KINDS = ['warn', 'idle', 'done'] as const
export const DIRECTIONS = ['in', 'out'] as const
export const DELIVERY_STATUSES = [
  '수신',
  '대기',
  '접수',
  '전송중',
  '완료',
  '실패',
] as const
export const SEND_CHANNELS = ['SMS', 'LMS', 'MMS'] as const
export const ROLES = ['관리자', '세무사', '상담 담당'] as const
export const USER_STATUSES = ['초대', '활성', '비활성'] as const
export const ATTACHMENT_DOWNLOAD_STATUSES = ['대기', '완료', '실패'] as const
export const EVENT_ACTOR_KINDS = ['user', 'customer', 'system'] as const

export type Status = (typeof STATUSES)[number]
export type TaskKind = (typeof TASK_KINDS)[number]
export type Direction = (typeof DIRECTIONS)[number]
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]
export type SendChannel = (typeof SEND_CHANNELS)[number]
export type Role = (typeof ROLES)[number]
export type UserStatus = (typeof USER_STATUSES)[number]
export type AttachmentDownloadStatus =
  (typeof ATTACHMENT_DOWNLOAD_STATUSES)[number]
export type EventActorKind = (typeof EVENT_ACTOR_KINDS)[number]

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
