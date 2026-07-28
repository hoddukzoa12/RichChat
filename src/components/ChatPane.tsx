import { useEffect, useRef } from 'react'
import { useInbox } from '../state/InboxContext'
import { assigneeLabel } from '../state/selectors'
import { ASSIGNEES } from '../data/seed'
import { STATUSES, STATUS_DOT, STATUS_TEXT } from '../theme'
import { Avatar, MenuItem, Popover } from './ui'
import type { Breakpoint } from '../hooks/useBreakpoint'

function Header({ breakpoint }: { breakpoint: Breakpoint }) {
  const { state, dispatch, cur } = useInbox()
  const label = assigneeLabel(cur)

  return (
    <div className="h-[66px] flex-none px-5 border-b border-line flex items-center gap-3 relative whitespace-nowrap">
      {breakpoint === 'mobile' && (
        <button
          type="button"
          className="text-[21px] text-brand leading-none flex-none"
          onClick={() => dispatch({ type: 'setMobileView', view: 'list' })}
        >
          ‹
        </button>
      )}

      <Avatar initial={cur.initial} className="w-[46px] h-[46px] text-lg" />

      <div className="min-w-0 overflow-hidden">
        <div className="flex items-center gap-[7px]">
          <span className="font-bold text-base tracking-[-0.3px]">{cur.name}</span>
          <span className="text-[13.5px] text-ink-500 overflow-hidden text-ellipsis">
            {cur.company}
          </span>
        </div>
        <div className="text-[12.5px] text-ink-400">{cur.phone}</div>
      </div>

      <div className="ml-auto flex items-center gap-2 flex-none">
        <div className="relative flex-none">
          <button
            type="button"
            className={`h-[34px] px-3 border border-line-strong rounded-[9px] flex items-center gap-1.5 text-[13.5px] font-semibold bg-white cursor-pointer ${
              STATUS_TEXT[cur.status]
            }`}
            onClick={() =>
              dispatch({ type: 'setMenu', value: state.menu === 'status' ? null : 'status' })
            }
          >
            <span className={`w-[7px] h-[7px] rounded-full ${STATUS_DOT[cur.status]}`} />
            {cur.status}
            <span className="text-[9px] text-ink-400 ml-0.5">▼</span>
          </button>
          <Popover
            open={state.menu === 'status'}
            onClose={() => dispatch({ type: 'setMenu', value: null })}
            className="top-10 left-0 w-[150px]"
          >
            {STATUSES.map((o) => (
              <MenuItem
                key={o}
                active={o === cur.status}
                onClick={() => dispatch({ type: 'setStatus', value: o })}
              >
                <span className={`w-[7px] h-[7px] rounded-full ${STATUS_DOT[o]}`} />
                {o}
              </MenuItem>
            ))}
          </Popover>
        </div>

        <div className="relative flex-none">
          {label ? (
            <button
              type="button"
              className="h-[34px] px-2.5 border border-line-strong rounded-[9px] flex items-center gap-1.5 text-[13.5px] font-semibold text-ink-700 hover:border-brand whitespace-nowrap"
              onClick={() =>
                dispatch({ type: 'setMenu', value: state.menu === 'assign' ? null : 'assign' })
              }
            >
              <Avatar initial={cur.assignees[0][0]} className="w-[18px] h-[18px] text-[10px]" />
              {label}
              <span className="text-[9px] text-ink-400">▼</span>
            </button>
          ) : (
            <button
              type="button"
              className="h-[34px] px-3 border border-dashed border-ink-300 rounded-[9px] flex items-center gap-1.5 text-[13.5px] font-medium text-ink-600 hover:border-brand hover:text-brand whitespace-nowrap"
              onClick={() =>
                dispatch({ type: 'setMenu', value: state.menu === 'assign' ? null : 'assign' })
              }
            >
              ＋ 담당자 배정
            </button>
          )}
          <Popover
            open={state.menu === 'assign'}
            onClose={() => dispatch({ type: 'setMenu', value: null })}
            className="top-10 left-0 w-[206px] rounded-[11px] p-1.5"
          >
            <div className="px-2 pt-1.5 pb-[7px] text-[11.5px] font-bold text-ink-400 tracking-[0.3px]">
              담당자 배정 · 여러 명 선택 가능
            </div>
            {ASSIGNEES.map((a) => {
              const on = cur.assignees.includes(a.name)
              return (
                <button
                  key={a.name}
                  type="button"
                  onClick={() => dispatch({ type: 'toggleAssignee', name: a.name })}
                  className={`w-full flex items-center gap-[9px] px-2.5 py-[7px] rounded-lg text-left ${
                    on ? 'bg-fill' : 'hover:bg-fill/60'
                  }`}
                >
                  <Avatar initial={a.initial} className="w-[26px] h-[26px] text-[11px]" />
                  <span>
                    <span className="block text-[13.5px]">{a.name}</span>
                    <span className="block text-[11.5px] text-ink-400">{a.role}</span>
                  </span>
                  <span
                    className={`ml-auto text-[13px] font-bold text-brand ${on ? 'visible' : 'invisible'}`}
                  >
                    ✓
                  </span>
                </button>
              )
            })}
            <div className="mt-1 pt-[5px] border-t border-fill">
              <button
                type="button"
                onClick={() => dispatch({ type: 'clearAssignees' })}
                className="w-full text-left px-2.5 py-2 rounded-[7px] text-[13px] text-open-fg hover:bg-open-bg"
              >
                배정 해제
              </button>
            </div>
          </Popover>
        </div>

        {cur.archived ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'unarchive' })}
            className="h-[34px] px-3.5 border border-line-strong rounded-[9px] bg-white text-ink-700 flex items-center text-[13.5px] font-semibold hover:border-brand hover:text-brand flex-none whitespace-nowrap"
          >
            보관 해제
          </button>
        ) : (
          <button
            type="button"
            onClick={() => dispatch({ type: 'archive' })}
            className="h-[34px] px-3.5 rounded-[9px] bg-brand text-white flex items-center text-[13.5px] font-semibold shadow-[0_1px_2px_rgba(16,24,40,.1)] hover:bg-brand-hover flex-none whitespace-nowrap"
          >
            보관
          </button>
        )}

        <button
          type="button"
          onClick={() => dispatch({ type: 'toggleCard' })}
          aria-label="고객 카드 토글"
          className={`h-[34px] px-3 rounded-[9px] flex items-center gap-1 text-[13.5px] font-semibold flex-none border ${
            state.cardOpen
              ? 'border-brand text-brand bg-brand-100'
              : 'border-line-strong text-ink-700 bg-white'
          }`}
        >
          <span className="w-[17px] h-3.5 border-[1.5px] border-current rounded-[3px] flex justify-end overflow-hidden">
            <span className="w-[5px] bg-current" />
          </span>
        </button>
      </div>
    </div>
  )
}

function Thread() {
  const { cur, state } = useInbox()
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [cur.id, cur.messages.length])

  return (
    <div className="flex-1 overflow-y-auto px-[26px] py-[22px] flex flex-col gap-4 bg-surface">
      <div className="flex items-center gap-3 text-ink-400 text-[12.5px]">
        <div className="flex-1 h-px bg-line" />
        2026년 7월 28일
        <div className="flex-1 h-px bg-line" />
      </div>

      {cur.messages.map((m, i) =>
        m.dir === 'in' ? (
          <div key={i} className="flex gap-2.5 max-w-[64%]">
            <Avatar initial={cur.initial} className="w-[30px] h-[30px] text-xs" />
            <div className="flex flex-col gap-1">
              <div className="bg-fill rounded-[4px_14px_14px_14px] px-[15px] py-[11px] text-[14.5px] text-ink whitespace-pre-wrap">
                {m.text}
              </div>
              <span className="text-[11.5px] text-ink-400 pl-0.5">{m.time}</span>
            </div>
          </div>
        ) : (
          <div key={i} className="flex gap-2.5 max-w-[64%] self-end flex-row-reverse">
            <div className="w-[30px] h-[30px] flex-none rounded-full bg-ink text-white flex items-center justify-center text-xs font-bold">
              {state.profile.name[0]}
            </div>
            <div className="flex flex-col gap-1 items-end">
              <div className="bg-brand text-white rounded-[14px_4px_14px_14px] px-[15px] py-[11px] text-[14.5px] whitespace-pre-wrap">
                {m.text}
              </div>
              <span className="text-[11.5px] text-ink-400 flex items-center gap-[5px] pr-0.5">
                <span className="text-done-dot font-semibold">전송 완료</span>· {m.time}
              </span>
            </div>
          </div>
        ),
      )}
      <div ref={endRef} />
    </div>
  )
}

function Composer() {
  const { state, dispatch } = useInbox()
  const canSend = state.draft.trim().length > 0

  return (
    <div className="flex-none border-t border-line px-5 pt-3.5 pb-4 bg-white">
      <div className="border-[1.5px] border-line-strong rounded-xl bg-white shadow-[0_1px_2px_rgba(16,24,40,.04)] focus-within:border-brand">
        <textarea
          value={state.draft}
          onChange={(e) => dispatch({ type: 'setDraft', value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              dispatch({ type: 'send', now: Date.now() })
            }
          }}
          placeholder="메시지를 입력하세요 (Enter 전송 · Shift+Enter 줄바꿈)"
          className="w-full h-[76px] resize-none border-none outline-none bg-transparent px-[15px] pt-3.5 pb-1.5 text-[14.5px] leading-[1.55] text-ink font-sans"
        />
        <div className="flex items-center gap-2 px-3 pb-[11px]">
          <button
            type="button"
            className="h-[30px] px-[11px] border border-line rounded-lg flex items-center text-[13px] text-ink-600 font-medium hover:border-brand hover:text-brand"
          >
            ＋ 파일
          </button>
          <span className="text-xs text-ink-400 ml-0.5">{state.draft.length} / 1,000자</span>
          <button
            type="button"
            disabled={!canSend}
            onClick={() => dispatch({ type: 'send', now: Date.now() })}
            className={`ml-auto h-[34px] px-5 rounded-[9px] text-white flex items-center text-sm font-semibold ${
              canSend ? 'bg-brand cursor-pointer hover:bg-brand-hover' : 'bg-line-soft cursor-default'
            }`}
          >
            전송
          </button>
        </div>
      </div>
    </div>
  )
}

export function ChatPane({ breakpoint }: { breakpoint: Breakpoint }) {
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-white">
      <Header breakpoint={breakpoint} />
      <Thread />
      <Composer />
    </div>
  )
}
