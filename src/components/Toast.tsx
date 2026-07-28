import { useInbox } from '../state/InboxContext'
import { Avatar } from './ui'
import type { Breakpoint } from '../hooks/useBreakpoint'

export function Toast({ breakpoint }: { breakpoint: Breakpoint }) {
  const { state, dispatch } = useInbox()
  const toast = state.toast
  if (!toast) return null

  const place =
    breakpoint === 'mobile'
      ? 'top-3 left-3 right-3'
      : 'left-[84px] bottom-[22px] w-[326px]'

  return (
    <div
      className={`absolute z-[60] bg-white border border-line rounded-xl shadow-[0_12px_32px_rgba(16,24,40,.18)] px-3.5 py-[13px] flex gap-[11px] items-start ${place}`}
    >
      <Avatar initial={toast.initial} className="w-[34px] h-[34px] text-[13px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13.5px] font-bold">{toast.name}</span>
          <span className="ml-auto text-[11.5px] text-ink-400">방금</span>
        </div>
        <div className="mt-[3px] text-[13px] text-ink-600 leading-normal">{toast.text}</div>
        <div className="mt-[9px] flex gap-[7px]">
          <button
            type="button"
            onClick={() => dispatch({ type: 'openToast' })}
            className="h-[29px] px-3 rounded-lg bg-brand text-white flex items-center text-[12.5px] font-semibold hover:bg-brand-hover"
          >
            대화 열기
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'dismissToast' })}
            className="h-[29px] px-3 border border-line-strong rounded-lg text-ink-600 flex items-center text-[12.5px] font-medium"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}
