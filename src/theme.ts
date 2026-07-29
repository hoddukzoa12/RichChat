import type {
  DeliveryStatus,
  Status,
  TaskKind,
  UserStatus,
} from './types'

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

export const MEMBER_STATUS_VIEW: Record<
  UserStatus,
  {
    label: string
    badgeClass: string
    rowClass: string
    avatarClass: string
  }
> = {
  초대: {
    label: '초대 발송됨',
    badgeClass: 'text-doing-fg bg-doing-bg',
    rowClass: '',
    avatarClass: 'opacity-55',
  },
  활성: {
    label: '활성',
    badgeClass: 'text-done-fg bg-done-bg',
    rowClass: '',
    avatarClass: '',
  },
  비활성: {
    label: '비활성',
    badgeClass: 'text-ink-500 bg-fill',
    rowClass: 'bg-surface-sunken opacity-70',
    avatarClass: 'grayscale',
  },
}

export const TASK_KIND_VIEW: Record<
  TaskKind,
  {
    optionLabel: string
    badge: string
    badgeClass: string
    cardClass: string
  }
> = {
  warn: {
    optionLabel: '진행 중',
    badge: 'D-3',
    badgeClass: 'font-bold text-doing-fg bg-doing-bg',
    cardClass: 'border-warn-border bg-warn-bg',
  },
  idle: {
    optionLabel: '대기',
    badge: '대기',
    badgeClass: 'font-semibold text-ink-600 bg-fill',
    cardClass: 'border-line',
  },
  done: {
    optionLabel: '완료',
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
