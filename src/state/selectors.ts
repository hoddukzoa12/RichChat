import {
  CONVERSATION_LIST_DEFAULT_LIMIT,
  type ConversationListAssignee,
  type ConversationListParams,
} from '../../shared/wire/conversation'
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
