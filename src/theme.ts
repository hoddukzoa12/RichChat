import type { Channel, Status } from './types'

export const STATUS_BADGE: Record<Status, string> = {
  미처리: 'text-open-fg bg-open-bg',
  처리중: 'text-doing-fg bg-doing-bg',
  완료: 'text-done-fg bg-done-bg',
}

export const STATUS_TEXT: Record<Status, string> = {
  미처리: 'text-open-fg',
  처리중: 'text-doing-fg',
  완료: 'text-done-fg',
}

export const STATUS_DOT: Record<Status, string> = {
  미처리: 'bg-open-dot',
  처리중: 'bg-doing-dot',
  완료: 'bg-done-dot',
}

export const CHANNEL_BADGE: Record<Channel, string> = {
  카톡: 'text-kakao-fg bg-kakao-bg',
  문자: 'text-brand-text bg-brand-100',
}

export const CHANNEL_FULL: Record<Channel, string> = {
  카톡: '카카오톡',
  문자: '문자',
}

export const CHANNEL_DOT: Record<'all' | Channel, string> = {
  all: 'bg-line-soft',
  카톡: 'bg-folder',
  문자: 'bg-brand-500',
}

/** 한세무 gets the purple tone; everyone else falls back to brand blue. */
export function avatarTone(initial: string): string {
  return initial === '한' ? 'bg-purple-bg text-purple-fg' : 'bg-brand-200 text-brand-text'
}

export const STATUSES: Status[] = ['미처리', '처리중', '완료']
