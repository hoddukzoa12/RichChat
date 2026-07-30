import {
  CONVERSATION_LIST_DEFAULT_LIMIT,
  type ConversationListAssignee,
  type ConversationListItem,
  type ConversationListParams,
  type ConversationOfficeChannel,
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

export function officeChannelLabel(
  channel: ConversationOfficeChannel | null,
): string {
  if (channel === null) return '업무폰 미지정'

  const label = channel.label.trim()
  return label ? `${label} · ${channel.value}` : channel.value
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

/**
 * 서버 페이지를 유지한 채 낙관적으로 필터 밖으로 이동한 대화만 숨긴다.
 * 실패 시 같은 항목을 복원하면 별도 목록 스냅샷 없이 즉시 다시 나타난다.
 */
export function visibleConversations(
  state: Pick<InboxState, 'archivedView' | 'convs' | 'filter'>,
): ConversationListItem[] {
  return state.convs.filter(
    (conversation) =>
      conversation.archived === state.archivedView &&
      (state.filter === '전체' || conversation.status === state.filter),
  )
}
