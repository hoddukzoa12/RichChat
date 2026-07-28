import { useInbox } from '../../state/InboxContext'
import type { CardTab } from '../../types'
import type { Breakpoint } from '../../hooks/useBreakpoint'
import { useCustomerCard } from '../../hooks/useCustomerCard'
import { AiTab } from './AiTab'
import { FolderTab } from './FolderTab'
import { InfoTab } from './InfoTab'

function tabClass(active: boolean): string {
  return `py-[11px] px-0.5 text-[13.5px] cursor-pointer border-b-2 flex items-center gap-1.5 ${
    active
      ? 'font-bold text-ink border-brand'
      : 'font-medium text-ink-500 border-transparent'
  }`
}

export function CustomerCard({ breakpoint }: { breakpoint: Breakpoint }) {
  const { state, dispatch } = useInbox()
  const customerCard = useCustomerCard()
  const editing =
    customerCard.data.editDraft?.conversationId === customerCard.conversationId
  const customerLoaded = customerCard.conversationId
    ? Boolean(
        customerCard.data.cardEntries[customerCard.conversationId]?.detail,
      )
    : false
  const savingCustomer =
    customerCard.data.savingCustomerConversationId ===
    customerCard.conversationId
  const overlay = breakpoint !== 'desktop'

  const shell = overlay
    ? `absolute top-0 right-0 bottom-0 z-50 ${
        breakpoint === 'mobile' ? 'w-full' : 'w-[360px]'
      } border-l border-line bg-surface-sunken flex flex-col shadow-[-8px_0_28px_rgba(16,24,40,.16)]`
    : 'w-[340px] flex-none border-l border-line bg-surface-sunken flex flex-col'

  const tabs: {
    key: CardTab
    label: string
    badge?: string
    badgeClass?: string
  }[] = [
    { key: 'info', label: '정보' },
    {
      key: 'folder',
      label: '폴더',
      badge: '웍스',
      badgeClass: 'text-works-fg bg-works-bg',
    },
    {
      key: 'ai',
      label: 'AI',
      badge: '요약·질문',
      badgeClass: 'text-brand-text bg-brand-100',
    },
  ]

  return (
    <>
      {overlay && (
        <div
          className="absolute inset-0 z-40 bg-ink/35"
          onClick={() => dispatch({ type: 'toggleCard' })}
        />
      )}

      <div className={shell}>
        <div className="h-[66px] flex-none px-[18px] border-b border-line flex items-center">
          <span className="text-[15px] font-bold tracking-[-0.3px]">
            고객 카드
          </span>
          {editing ? (
            <span className="ml-auto flex gap-[7px]">
              <button
                type="button"
                disabled={savingCustomer}
                onClick={() =>
                  customerCard.dispatchData({ type: 'cancelEdit' })
                }
                className="h-7 px-2.5 border border-line-strong rounded-lg flex items-center text-[12.5px] font-semibold text-ink-600"
              >
                취소
              </button>
              <button
                type="button"
                disabled={savingCustomer}
                onClick={customerCard.saveCustomer}
                className="h-7 px-3 rounded-lg bg-brand text-white flex items-center text-[12.5px] font-semibold hover:bg-brand-hover disabled:opacity-50"
              >
                {savingCustomer ? '저장 중' : '저장'}
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={!customerLoaded}
              onClick={() => {
                if (!customerCard.conversationId) return
                customerCard.dispatchData({
                  type: 'startEdit',
                  conversationId: customerCard.conversationId,
                })
              }}
              className="ml-auto text-[13px] text-brand font-semibold disabled:text-ink-300"
            >
              편집
            </button>
          )}
          <button
            type="button"
            onClick={() => dispatch({ type: 'toggleCard' })}
            aria-label="닫기"
            className="ml-3.5 text-ink-400 text-[15px]"
          >
            ✕
          </button>
        </div>

        <div className="flex-none flex px-4 gap-[18px] border-b border-line bg-surface-sunken">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tabClass(state.tab === t.key)}
              onClick={() => dispatch({ type: 'setTab', tab: t.key })}
            >
              {t.label}
              {t.badge && (
                <span
                  className={`text-[10.5px] font-semibold rounded px-1.5 py-[1.5px] ${t.badgeClass}`}
                >
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {state.tab === 'info' && <InfoTab controller={customerCard} />}
          {state.tab === 'folder' && <FolderTab />}
          {state.tab === 'ai' && <AiTab />}
        </div>
      </div>
    </>
  )
}
