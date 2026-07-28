import { useInbox } from '../state/InboxContext'
import {
  archivedCount,
  assigneeLabel,
  preview,
  scopeCount,
  statusCounts,
  visibleList,
} from '../state/selectors'
import type { Conversation, Scope, StatusFilter } from '../types'
import { Avatar, MenuItem, Popover, StatusBadge } from './ui'
import type { Breakpoint } from '../hooks/useBreakpoint'

const FILTERS: StatusFilter[] = ['전체', '미처리', '처리중', '완료']

const SCOPE_OPTIONS: { key: Scope; label: string }[] = [
  { key: 'all', label: '전체 담당' },
  { key: 'mine', label: '내 담당' },
  { key: 'none', label: '미배정' },
]

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

function Row({ conv }: { conv: Conversation }) {
  const { state, dispatch } = useInbox()
  const selected = conv.id === state.selected
  const unread = conv.unread > 0
  const label = assigneeLabel(conv)

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
          {conv.name}
        </span>
        {conv.company && <span className="text-[13px] text-ink-400">{conv.company}</span>}
        <span
          className={`ml-auto text-xs ${unread ? 'font-bold text-brand' : 'font-normal text-ink-400'}`}
        >
          {conv.time}
        </span>
      </div>

      <div className="flex items-center gap-[7px]">
        <span
          className={`flex-1 min-w-0 text-[13.5px] truncate ${
            unread ? 'text-ink font-semibold' : 'text-ink-600 font-normal'
          }`}
        >
          {preview(conv)}
        </span>
        {unread && (
          <span className="ml-auto flex-none min-w-[19px] h-[19px] rounded-[10px] bg-brand text-white text-[11px] font-bold flex items-center justify-center px-1.5">
            {conv.unread}
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
            <Avatar initial={conv.assignees[0][0]} className="w-[18px] h-[18px] text-[10px]" />
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
  const list = visibleList(state)
  const counts = statusCounts(state)

  const width =
    breakpoint === 'mobile'
      ? 'flex-1 min-w-0'
      : breakpoint === 'tablet'
        ? 'w-[292px] flex-none border-r border-line'
        : 'w-[328px] flex-none border-r border-line'

  const scopeLabel = SCOPE_OPTIONS.find((o) => o.key === state.scope)!.label

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
              {SCOPE_OPTIONS.map((o) => (
                <MenuItem
                  key={o.key}
                  active={state.scope === o.key}
                  onClick={() => dispatch({ type: 'setScope', value: o.key })}
                >
                  {o.label}
                  <span className="ml-auto text-xs text-ink-400">{scopeCount(state, o.key)}</span>
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
            보관 {archivedCount(state)}
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
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={chipClass(state.filter === f)}
              onClick={() => dispatch({ type: 'setFilter', value: f })}
            >
              {f === '전체' ? '전체' : `${f} ${counts[f]}`}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-3.5 flex flex-col gap-1">
        {list.map((c) => (
          <Row key={c.id} conv={c} />
        ))}
        {list.length === 0 && (
          <div className="px-3 py-9 text-center text-[13px] text-ink-400 leading-relaxed">
            조건에 맞는 대화가 없습니다
          </div>
        )}
      </div>
    </div>
  )
}
