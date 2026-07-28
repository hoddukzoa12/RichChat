export const CHANNELS = ['카톡', '문자'] as const
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
export const SEND_CHANNELS = ['카톡', 'SMS', 'LMS', 'MMS'] as const
export const ROLES = ['관리자', '세무사', '상담 담당'] as const
export const USER_STATUSES = ['초대', '활성', '비활성'] as const

export type Channel = (typeof CHANNELS)[number]
export type Status = (typeof STATUSES)[number]
export type TaskKind = (typeof TASK_KINDS)[number]
export type Direction = (typeof DIRECTIONS)[number]
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]
export type SendChannel = (typeof SEND_CHANNELS)[number]
export type Role = (typeof ROLES)[number]
export type UserStatus = (typeof USER_STATUSES)[number]
