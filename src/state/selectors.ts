import {
  CONVERSATION_LIST_DEFAULT_LIMIT,
  type ConversationListAssignee,
  type ConversationListParams,
} from '../../shared/wire/conversation'
import type { Conversation } from '../types'
import type { InboxState } from './inbox'

type AssigneeSource = {
  assignees: Array<string | ConversationListAssignee>
}

function assigneeName(assignee: string | ConversationListAssignee): string {
  return typeof assignee === 'string' ? assignee : assignee.name
}

export function assigneeLabel(c: AssigneeSource): string {
  const first = c.assignees[0]
  if (!first) return ''
  const name = assigneeName(first)
  return c.assignees.length > 1
    ? `${name} 외 ${c.assignees.length - 1}`
    : name
}

/** 목록 훅과 실시간 재동기화가 같은 서버 필터를 쓰게 한다. */
export function conversationListParams(
  state: Pick<InboxState, 'archivedView' | 'filter' | 'query' | 'scope'>,
  query = state.query,
): ConversationListParams {
  const normalizedQuery = query.trim()
  return {
    archived: state.archivedView,
    scope: state.scope,
    status: state.filter,
    q: normalizedQuery || undefined,
    limit: CONVERSATION_LIST_DEFAULT_LIMIT,
  }
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
