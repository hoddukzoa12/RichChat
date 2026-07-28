import { useInbox } from '../state/InboxContext'
import type { Page } from '../types'
import { useAuth } from '../api/AuthGate'

function railClass(active: boolean): string {
  return `w-11 py-2 rounded-[10px] flex flex-col items-center gap-[3px] text-[10px] relative cursor-pointer ${
    active ? 'font-semibold text-white bg-white/12' : 'font-medium text-ink-400 hover:bg-white/5'
  }`
}

function RailButton({
  page,
  emoji,
  label,
  badge,
}: {
  page: Page
  emoji: string
  label: string
  badge?: number
}) {
  const { state, dispatch } = useInbox()
  return (
    <button
      type="button"
      className={railClass(state.page === page)}
      onClick={() => dispatch({ type: 'setPage', page })}
    >
      <span className="text-base leading-none">{emoji}</span>
      {label}
      {badge ? (
        <span className="absolute top-1 right-[5px] min-w-4 h-4 rounded-lg bg-open-dot text-white text-[10px] font-bold flex items-center justify-center px-1">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

export function Rail() {
  const { state } = useInbox()
  const { me } = useAuth()

  return (
    <div className="w-16 flex-none bg-ink flex flex-col items-center py-3.5 gap-1.5">
      {/* The mark is dark red on transparent, so it needs a light tile to read
          against the dark rail. */}
      <img
        src="/logo.png"
        alt="세무법인 리치"
        className="w-10 h-10 rounded-xl object-contain bg-white p-1 mb-2.5"
      />

      <RailButton
        page="chat"
        emoji="💬"
        label="대화"
        badge={state.facets.status.미처리}
      />

      <div className="mt-auto flex flex-col items-center gap-2.5">
        {me.isAdmin && <RailButton page="office" emoji="🏢" label="사무소" />}
        <RailButton page="settings" emoji="⚙️" label="설정" />
        <div className="w-8 h-8 rounded-full bg-ink-700 text-white flex items-center justify-center text-xs font-semibold border-2 border-ink shadow-[0_0_0_2px_#12B76A]">
          {me.user.name[0]}
        </div>
      </div>
    </div>
  )
}

/** Mobile replacement for the rail — 대화 / 설정 tabs pinned to the bottom. */
export function MobileTabBar() {
  const { state, dispatch } = useInbox()
  const tabs: { page: Page; emoji: string; label: string }[] = [
    { page: 'chat', emoji: '💬', label: '대화' },
    { page: 'settings', emoji: '⚙️', label: '설정' },
  ]

  return (
    <div className="flex-none border-t border-line flex pt-[9px] pb-[26px] bg-white">
      {tabs.map((t) => (
        <button
          key={t.page}
          type="button"
          onClick={() => dispatch({ type: 'setPage', page: t.page })}
          className={`flex-1 flex flex-col items-center gap-[3px] text-[11px] ${
            state.page === t.page ? 'font-semibold text-brand' : 'font-medium text-ink-400'
          }`}
        >
          <span className="text-[19px] leading-none">{t.emoji}</span>
          {t.label}
        </button>
      ))}
    </div>
  )
}
