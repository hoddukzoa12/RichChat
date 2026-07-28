import { useInbox } from '../state/InboxContext'
import type { OfficeSettings as OfficeFlags } from '../state/inbox'
import { Avatar, Card, ToggleRow } from './ui'

const CHANNELS = [
  {
    name: '카카오톡 채널 @세무법인리치',
    sub: '채널톡 · 알림톡 발송 가능',
    state: '연결됨',
    action: '관리',
    dot: 'bg-folder',
  },
  {
    name: '문자 발신번호 02-556-1234',
    sub: 'SMS · LMS',
    state: '연결됨',
    action: '관리',
    dot: 'bg-brand-500',
  },
  {
    name: 'LGU+ 메시지허브',
    sub: 'API 키 · 발송 한도 월 20,000건',
    state: '정상',
    action: '설정',
    dot: 'bg-done-dot',
  },
]

const OFFICE_TOGGLES: { key: keyof OfficeFlags; name: string; sub: string }[] = [
  {
    key: 'aiOn',
    name: 'AI 기능 사용',
    sub: '요약·자동 입력·답장 초안을 전 직원에게 허용합니다',
  },
  { key: 'docRead', name: '첨부 문서 읽기 허용', sub: '대화에 첨부된 문서를 AI가 참고합니다' },
  { key: 'exportLog', name: '대화 내보내기 기록', sub: '누가 언제 대화를 내보냈는지 남깁니다' },
]

const ROLES = [
  { name: '상담 담당', sub: '대화 응대와 고객 정보 편집' },
  { name: '세무사', sub: '담당 고객 대화 확인과 응대' },
  { name: '관리자', sub: '사무소 설정과 직원 권한 관리' },
]

function InviteModal() {
  const { state, dispatch } = useInbox()
  if (!state.inviteOpen) return null
  const canSend = state.inviteEmail.trim().length > 0

  return (
    <>
      <div
        className="absolute inset-0 z-[80] bg-ink/45"
        onClick={() => dispatch({ type: 'closeInvite' })}
      />
      <div className="absolute z-[90] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[calc(100%-32px)] bg-white rounded-2xl shadow-[0_24px_56px_rgba(16,24,40,.3)] p-[22px]">
        <div className="flex items-center mb-1">
          <span className="text-[17px] font-bold tracking-[-0.3px]">직원 초대</span>
          <button
            type="button"
            onClick={() => dispatch({ type: 'closeInvite' })}
            className="ml-auto text-[17px] text-ink-400"
          >
            ✕
          </button>
        </div>
        <div className="text-[13px] text-ink-400 mb-[18px]">
          초대 메일이 발송되고, 수락하면 인박스에 참여합니다
        </div>

        <div className="text-[12.5px] font-semibold text-ink-700 mb-[7px]">이메일</div>
        <input
          value={state.inviteEmail}
          onChange={(e) => dispatch({ type: 'setInviteEmail', value: e.target.value })}
          placeholder="name@rich.kr"
          className="w-full text-sm text-ink border border-line-strong rounded-[9px] px-3 py-2.5 outline-none focus:border-brand"
        />

        <div className="text-[12.5px] font-semibold text-ink-700 mt-4 mb-2">권한</div>
        <div className="flex flex-col gap-2">
          {ROLES.map((r) => {
            const on = state.inviteRole === r.name
            return (
              <button
                key={r.name}
                type="button"
                onClick={() => dispatch({ type: 'setInviteRole', value: r.name })}
                className={`flex items-center gap-2.5 px-3 py-[11px] rounded-[10px] text-left border ${
                  on ? 'border-brand bg-brand-50' : 'border-line bg-white'
                }`}
              >
                <span
                  className={`w-4 h-4 flex-none rounded-full ${
                    on ? 'border-[5px] border-brand' : 'border-[1.5px] border-line-soft'
                  }`}
                />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold">{r.name}</span>
                  <span className="block text-[12.5px] text-ink-400">{r.sub}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="mt-5 flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => dispatch({ type: 'closeInvite' })}
            className="h-9 px-3.5 border border-line-strong rounded-[9px] flex items-center text-[13.5px] font-medium text-ink-600"
          >
            취소
          </button>
          <button
            type="button"
            disabled={!canSend}
            onClick={() => dispatch({ type: 'sendInvite' })}
            className={`h-9 px-4 rounded-[9px] flex items-center text-[13.5px] font-semibold text-white ${
              canSend ? 'bg-brand cursor-pointer hover:bg-brand-hover' : 'bg-line-soft cursor-default'
            }`}
          >
            초대 보내기
          </button>
        </div>
      </div>
    </>
  )
}

export function OfficeSettings() {
  const { state, dispatch } = useInbox()

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-white relative">
      <div className="h-[66px] flex-none px-6 border-b border-line flex items-center gap-2.5">
        <span className="text-[19px] font-bold tracking-[-0.4px]">사무소 설정</span>
        <span className="text-[11.5px] font-bold text-purple-fg bg-purple-soft rounded-[5px] px-2 py-0.5">
          관리자
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-[22px] bg-surface">
        <div className="max-w-[760px] flex flex-col gap-4">
          <Card className="p-[18px]">
            <div className="text-sm font-bold mb-1">채널 연동</div>
            <div className="text-[12.5px] text-ink-400 mb-3.5">
              LGU+ 메시지허브를 통해 카카오톡·문자를 한 인박스에서 주고받습니다
            </div>
            <div className="flex flex-col gap-[9px]">
              {CHANNELS.map((ch) => (
                <div
                  key={ch.name}
                  className="flex items-center gap-[11px] px-[13px] py-3 border border-line rounded-[10px]"
                >
                  <span className={`w-2.5 h-2.5 rounded-[3px] flex-none ${ch.dot}`} />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold">{ch.name}</span>
                    <span className="block text-xs text-ink-400">{ch.sub}</span>
                  </span>
                  <span className="ml-auto text-[11.5px] font-semibold text-done-fg bg-done-bg rounded-[5px] px-2 py-0.5">
                    {ch.state}
                  </span>
                  <button
                    type="button"
                    className="h-[30px] px-[11px] border border-line-strong rounded-lg flex items-center text-[12.5px] font-semibold text-ink-700 hover:border-brand hover:text-brand"
                  >
                    {ch.action}
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-[13px] px-[13px] py-3 rounded-[10px] bg-surface-sunken flex items-center gap-2.5">
              <span className="text-[12.5px] text-ink-600">이번 달 발송</span>
              <span className="text-[13.5px] font-bold">3,182건</span>
              <span className="text-[12.5px] text-ink-400">/ 20,000건</span>
              <span className="ml-auto w-40 h-2 rounded bg-line overflow-hidden block">
                <span className="block w-[16%] h-full bg-brand" />
              </span>
            </div>
          </Card>

          <Card className="p-[18px]">
            <div className="flex items-center mb-3.5">
              <span className="text-sm font-bold">직원 · 권한</span>
              <button
                type="button"
                onClick={() => dispatch({ type: 'openInvite' })}
                className="ml-auto text-[12.5px] text-brand font-semibold"
              >
                ＋ 초대
              </button>
            </div>
            <div className="flex flex-col gap-[9px]">
              {state.team.map((m) => (
                <div
                  key={m.email}
                  className="flex items-center gap-[11px] px-[13px] py-[11px] border border-line rounded-[10px]"
                >
                  <Avatar
                    initial={m.initial}
                    className={`w-8 h-8 text-xs ${m.pending ? 'opacity-55' : ''}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold">{m.name}</span>
                    <span className="block text-xs text-ink-400">{m.email}</span>
                  </span>
                  {m.pending && (
                    <span className="text-[11.5px] font-semibold text-doing-fg bg-doing-bg rounded-[5px] px-2 py-0.5">
                      초대 발송됨
                    </span>
                  )}
                  <span className="ml-auto text-[12.5px] text-ink-600 bg-fill rounded-md px-2.5 py-1 font-semibold cursor-pointer">
                    {m.role} ▾
                  </span>
                  <span className="text-[12.5px] text-ink-400 cursor-pointer">비활성화</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-[18px]">
            <div className="text-sm font-bold mb-3.5">AI · 데이터 정책</div>
            <div className="flex flex-col gap-1">
              {OFFICE_TOGGLES.map((t) => (
                <ToggleRow
                  key={t.key}
                  name={t.name}
                  sub={t.sub}
                  on={state.office[t.key]}
                  onFlip={() => dispatch({ type: 'toggleOffice', key: t.key })}
                />
              ))}
            </div>
            <div className="mt-[13px] pt-[13px] border-t border-fill flex items-center gap-3">
              <span className="min-w-0">
                <span className="block text-[13.5px] font-semibold">대화 보존 기간</span>
                <span className="block text-[12.5px] text-ink-400">
                  기간이 지난 대화는 자동 보관 처리됩니다
                </span>
              </span>
              <span className="ml-auto h-8 px-3 border border-line-strong rounded-lg flex items-center text-[13px] font-semibold text-ink-700 cursor-pointer">
                5년 ▾
              </span>
            </div>
          </Card>
        </div>
      </div>

      <InviteModal />
    </div>
  )
}
