import type { DeliveryStatus, Status, TaskKind } from './types'

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

export const DELIVERY_STATUS_BADGE: Record<DeliveryStatus, string> = {
  수신: 'text-ink-500 bg-fill',
  대기: 'text-ink-500 bg-fill',
  접수: 'text-doing-fg bg-doing-bg',
  전송중: 'text-doing-fg bg-doing-bg',
  완료: 'text-done-fg bg-done-bg',
  실패: 'text-open-fg bg-open-bg',
}

export const TASK_KIND_VIEW: Record<
  TaskKind,
  { badge: string; badgeClass: string; cardClass: string }
> = {
  warn: {
    badge: 'D-3',
    badgeClass: 'font-bold text-doing-fg bg-doing-bg',
    cardClass: 'border-warn-border bg-warn-bg',
  },
  idle: {
    badge: '대기',
    badgeClass: 'font-semibold text-ink-600 bg-fill',
    cardClass: 'border-line',
  },
  done: {
    badge: '완료',
    badgeClass: 'font-bold text-done-fg bg-done-bg',
    cardClass: 'border-line bg-done-bg/30',
  },
}

/** 한세무 gets the purple tone; everyone else falls back to brand blue. */
export function avatarTone(initial: string): string {
  return initial === '한' ? 'bg-purple-bg text-purple-fg' : 'bg-brand-200 text-brand-text'
}

export const STATUSES: Status[] = ['미처리', '처리중', '완료']
