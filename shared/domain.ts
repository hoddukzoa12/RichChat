export type Channel = '카톡' | '문자'
export type Status = '미처리' | '처리중' | '완료'
export type TaskKind = 'warn' | 'idle' | 'done'
export type Direction = 'in' | 'out'
export type DeliveryStatus = '수신' | '대기' | '접수' | '전송중' | '완료' | '실패'
export type SendChannel = '카톡' | 'SMS' | 'LMS' | 'MMS'
export type Role = '관리자' | '세무사' | '상담 담당'
export type UserStatus = '초대' | '활성' | '비활성'

export const STATUSES: readonly Status[] = ['미처리', '처리중', '완료']
export const CHANNELS: readonly Channel[] = ['카톡', '문자']
