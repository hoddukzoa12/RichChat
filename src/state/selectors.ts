import type { Conversation, Status, StatusFilter } from '../types'
import { ME } from '../data/seed'
import type { InboxState } from './inbox'

/** Last message text — the list preview is always derived, never stored. */
export function preview(c: Conversation): string {
  return c.messages.length ? c.messages[c.messages.length - 1].text : ''
}

export function assigneeLabel(c: Conversation): string {
  if (c.assignees.length > 1) return `${c.assignees[0]} 외 ${c.assignees.length - 1}`
  return c.assignees[0] ?? ''
}

function inScope(c: Conversation, scope: InboxState['scope']): boolean {
  if (scope === 'all') return true
  if (scope === 'mine') return c.assignees.includes(ME)
  return c.assignees.length === 0
}

export function visibleList(state: InboxState): Conversation[] {
  const q = state.query.trim()
  return state.convs.filter(
    (c) =>
      c.archived === state.archivedView &&
      inScope(c, state.scope) &&
      (state.chan === 'all' || c.channel === state.chan) &&
      (state.filter === '전체' || c.status === state.filter) &&
      (!q || c.name.includes(q) || c.company.includes(q) || c.phone.includes(q)),
  )
}

export type StatusCounts = Record<StatusFilter, number>

export function statusCounts(state: InboxState): StatusCounts {
  const counts: StatusCounts = { 전체: state.convs.length, 미처리: 0, 처리중: 0, 완료: 0 }
  for (const c of state.convs) counts[c.status as Status] += 1
  return counts
}

export function channelCount(state: InboxState, key: 'all' | Conversation['channel']): number {
  return key === 'all' ? state.convs.length : state.convs.filter((c) => c.channel === key).length
}

export function scopeCount(state: InboxState, key: InboxState['scope']): number {
  return state.convs.filter((c) => inScope(c, key)).length
}

export function archivedCount(state: InboxState): number {
  return state.convs.filter((c) => c.archived).length
}

/** Canned AI answers, keyed off what the question mentions. */
export function answerFor(c: Conversation, question: string): string {
  const open = c.todos.filter((t) => !t.done).map((t) => t.text)

  if (question.includes('이력') || question.includes('지난')) {
    return `${c.name} 고객은 최근 3건 문의가 있었습니다. 이번 건은 ${c.summary}`
  }
  if (question.includes('문서') || question.includes('폴더')) {
    return c.folderLinked
      ? `${c.folderPath} 폴더의 ${c.docs.length}건을 확인했습니다. 가장 최근 문서는 ${
          c.docs[0]?.name ?? '없음'
        }입니다.`
      : '아직 이 고객의 폴더가 연결되지 않았습니다. 폴더 탭에서 지정하면 문서를 참고해 답변할 수 있습니다.'
  }
  if (question.includes('기다') || question.includes('할 일') || question.includes('뭐야')) {
    if (!open.length) return '남은 조치는 없습니다. 완료 처리해도 됩니다.'
    const task = c.tasks[0]
    const tail = task ? ` ${task.name}(${task.sub})도 함께 확인하세요.` : ''
    return `지금 남은 조치는 “${open.join('”, “')}” 입니다.${tail}`
  }
  if (question.includes('초안') || question.includes('답장')) {
    return `이렇게 보내면 좋겠습니다 — “${c.draft || '확인 후 회신드리겠습니다.'}”`
  }
  return `${c.name} 고객 기준으로 확인했습니다. ${c.summary}`
}

export const AI_SUGGESTIONS = [
  '이 고객이 지금 기다리는 게 뭐야?',
  '지난 문의 이력 요약해줘',
  '폴더 문서에서 최근 신고 내역 찾아줘',
]
