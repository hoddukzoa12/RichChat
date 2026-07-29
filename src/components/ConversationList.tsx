import { useInbox } from '../state/InboxContext'
import {
  assigneeLabel,
  visibleConversations,
} from '../state/selectors'
import { Avatar, MenuItem, Popover, StatusBadge } from './ui'
import type { Breakpoint } from '../hooks/useBreakpoint'
import {
  CONVERSATION_SCOPES,
  CONVERSATION_STATUS_FILTERS,
  type ConversationListItem,
  type ConversationScope,
} from '../../shared/wire/conversation'
import { useConversationList } from '../hooks/useConversationList'
import { formatRelativeTime } from '../lib/time'

const SCOPE_LABELS: Record<ConversationScope, string> = {
  all: '전체 담당',
  mine: '내 담당',
  none: '미배정',
}

function pillClass(active: boolean): string {
  return `flex items-center gap-[5px] text-[12.5px] font-semibold px-[9px] py-1 rounded-2xl cursor-pointer whitespace-nowrap border ${
    active ? 'border-brand text-brand-text bg-brand-100' : 'border-line-strong text-ink-600 bg-white'
  }`
}

function chipClass(active: boolean): string {
  return `px-2.5 py-[5px] rounded-2xl text-[13px] cursor-pointer whitespace-nowrap ${
    active
      ? 'bg-ink text-white font-semibold'
      : 'bg-white border border-line-strong text-ink-600 font-medium'
  }`
}

function Row({ conv }: { conv: ConversationListItem }) {
  const { state, dispatch } = useInbox()
  const selected = conv.id === state.selected
  const unread = conv.unreadCount > 0
  const label = assigneeLabel(conv)
  const lastMessageTime =
    conv.lastMessageAt === null ? '' : formatRelativeTime(conv.lastMessageAt)

  return (
    <button
      type="button"
      onClick={() => dispatch({ type: 'select', id: conv.id })}
      className={`text-left px-[13px] py-3 rounded-[11px] flex flex-col gap-1.5 cursor-pointer border ${
        selected
          ? 'bg-white border-[1.5px] border-brand shadow-[0_2px_8px_rgba(44,107,237,.13)]'
          : 'border-transparent hover:bg-white/70'
      }`}
    >
      <div className="flex items-center gap-[7px]">
        {unread && <span className="w-[7px] h-[7px] rounded-full bg-brand flex-none" />}
        <span
          className={`text-[14.5px] tracking-[-0.2px] ${unread ? 'font-extrabold' : 'font-bold'}`}
        >
          {conv.customer.name}
        </span>
        {conv.customer.company && (
          <span className="text-[13px] text-ink-400">
            {conv.customer.company}
          </span>
        )}
        <span
          className={`ml-auto text-xs ${unread ? 'font-bold text-brand' : 'font-normal text-ink-400'}`}
        >
          {lastMessageTime}
        </span>
      </div>

      <div className="flex items-center gap-[7px]">
        <span
          className={`flex-1 min-w-0 text-[13.5px] truncate ${
            unread ? 'text-ink font-semibold' : 'text-ink-600 font-normal'
          }`}
        >
          {conv.preview}
        </span>
        {unread && (
          <span className="ml-auto flex-none min-w-[19px] h-[19px] rounded-[10px] bg-brand text-white text-[11px] font-bold flex items-center justify-center px-1.5">
            {conv.unreadCount}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <StatusBadge status={conv.status} />
        {conv.label && (
          <span className="text-[11.5px] text-ink-600 bg-fill rounded-[5px] px-[7px] py-[1.5px]">
            {conv.label}
          </span>
        )}
        {label ? (
          <span className="ml-auto flex items-center gap-[5px] text-xs text-ink-500">
            <Avatar
              initial={conv.assignees[0].name[0]}
              className="w-[18px] h-[18px] text-[10px]"
            />
            {label}
          </span>
        ) : (
          <span className="ml-auto text-xs text-ink-400">담당 없음</span>
        )}
      </div>
    </button>
  )
}

export function ConversationList({ breakpoint }: { breakpoint: Breakpoint }) {
  const { state, dispatch } = useInbox()
  const { loadMore, retry } = useConversationList(state, dispatch)
  const list = visibleConversations(state)
  const counts = state.facets.status

  const width =
    breakpoint === 'mobile'
      ? 'flex-1 min-w-0'
      : breakpoint === 'tablet'
        ? 'w-[292px] flex-none border-r border-line'
        : 'w-[328px] flex-none border-r border-line'

  const scopeLabel = SCOPE_LABELS[state.scope]
  const firstLoading =
    state.listLoadStatus === 'idle' || state.listLoadStatus === 'loading'

  return (
    <div className={`bg-surface-sunken flex flex-col ${width}`}>
      <div className="px-[18px] pt-[18px] pb-3 flex flex-col gap-3 relative">
        <div className="flex items-center gap-1.5 flex-wrap gap-y-2">
          <span className="text-[19px] font-bold tracking-[-0.4px] flex-none whitespace-nowrap mr-0.5">
            대화
          </span>

          <div className="relative">
            <button
              type="button"
              className={pillClass(state.scope !== 'all')}
              onClick={() =>
                dispatch({ type: 'setMenu', value: state.menu === 'scope' ? null : 'scope' })
              }
            >
              {scopeLabel}
              <span className="text-[8px] text-ink-400">▼</span>
            </button>
            <Popover
              open={state.menu === 'scope'}
              onClose={() => dispatch({ type: 'setMenu', value: null })}
              className="top-9 left-0 w-[150px]"
            >
              {CONVERSATION_SCOPES.map((scope) => (
                <MenuItem
                  key={scope}
                  active={state.scope === scope}
                  onClick={() => dispatch({ type: 'setScope', value: scope })}
                >
                  {SCOPE_LABELS[scope]}
                  <span className="ml-auto text-xs text-ink-400">
                    {state.facets.scope[scope]}
                  </span>
                </MenuItem>
              ))}
            </Popover>
          </div>

          <button
            type="button"
            className={pillClass(state.archivedView)}
            onClick={() => dispatch({ type: 'toggleArchivedView' })}
          >
            <span className="w-3 h-2.5 border-[1.5px] border-current rounded-sm block" />
            보관 {state.facets.archive.archived}
          </button>
        </div>

        <div className="h-9 bg-white border border-line-strong rounded-[9px] flex items-center gap-2 px-[11px] shadow-[0_1px_2px_rgba(16,24,40,.04)]">
          <span className="w-[13px] h-[13px] border-[1.6px] border-ink-400 rounded-full flex-none" />
          <input
            value={state.query}
            onChange={(e) => dispatch({ type: 'setQuery', value: e.target.value })}
            placeholder="고객명 · 전화번호 검색"
            className="flex-1 min-w-0 border-none outline-none bg-transparent text-[13.5px] text-ink"
          />
        </div>

        <div className="flex gap-1 flex-wrap">
          {CONVERSATION_STATUS_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className={chipClass(state.filter === filter)}
              onClick={() => dispatch({ type: 'setFilter', value: filter })}
            >
              {filter === '전체'
                ? '전체'
                : `${filter} ${counts[filter]}`}
            </button>
          ))}
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto px-2.5 pb-3.5 flex flex-col gap-1"
        onScroll={(event) => {
          const listElement = event.currentTarget
          const remaining =
            listElement.scrollHeight -
            listElement.scrollTop -
            listElement.clientHeight
          if (remaining < 80) loadMore()
        }}
      >
        {firstLoading && (
          <div className="px-3 py-9 text-center text-[13px] text-ink-400 leading-relaxed">
            대화 목록을 불러오고 있습니다
          </div>
        )}

        {state.listLoadStatus === 'failed' && (
          <div
            role="alert"
            className="px-3 py-9 text-center text-[13px] text-open-fg leading-relaxed"
          >
            <div>{state.listError}</div>
            <button
              type="button"
              onClick={retry}
              className="mt-3 rounded-lg border border-open-fg px-3 py-1.5 font-semibold"
            >
              다시 시도
            </button>
          </div>
        )}

        {list.map((c) => (
          <Row key={c.id} conv={c} />
        ))}

        {state.listLoadStatus === 'loaded' && list.length === 0 && (
          <div className="px-3 py-9 text-center text-[13px] text-ink-400 leading-relaxed">
            조건에 맞는 대화가 없습니다
          </div>
        )}

        {state.loadingMore && (
          <div className="px-3 py-4 text-center text-[12px] text-ink-400">
            대화를 더 불러오고 있습니다
          </div>
        )}

        {state.listError && list.length > 0 && (
          <div
            role="alert"
            className="px-3 py-4 text-center text-[12px] text-open-fg"
          >
            <div>{state.listError}</div>
            <button
              type="button"
              onClick={loadMore}
              className="mt-2 rounded-lg border border-open-fg px-2.5 py-1 font-semibold"
            >
              다시 시도
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
