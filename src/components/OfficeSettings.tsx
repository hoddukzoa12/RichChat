import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../api/AuthGate'
import {
  getOfficeSettings,
  inviteOfficeMember,
  INVITE_ROLES,
  RETENTION_YEARS_MAX,
  RETENTION_YEARS_MIN,
  updateOfficeSettings,
  type InviteRole,
  type OfficeMember,
  type OfficeMemberWithStatus,
  type OfficeSettings as SavedOfficeSettings,
} from '../api/endpoints'
import { useInbox } from '../state/InboxContext'
import type { OfficeSettings as OfficeFlags } from '../state/inbox'
import { Avatar, Card, ToggleRow } from './ui'

const CONNECTIONS = [
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

const OFFICE_TOGGLES: Array<{
  key: keyof OfficeFlags
  name: string
  sub: string
}> = [
  {
    key: 'aiOn',
    name: 'AI 기능 사용',
    sub: '요약·자동 입력·답장 초안을 전 직원에게 허용합니다',
  },
  {
    key: 'docRead',
    name: '첨부 문서 읽기 허용',
    sub: '대화에 첨부된 문서를 AI가 참고합니다',
  },
]

const ROLE_DESCRIPTION: Record<InviteRole, string> = {
  부관리자: '관리자 기능을 함께 쓰되 관리자 지정은 할 수 없습니다',
  '상담 담당': '대화 응대와 고객 정보 편집',
  세무사: '담당 고객 대화 확인과 응대',
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function hasStatus(
  member: OfficeMember | OfficeMemberWithStatus,
): member is OfficeMemberWithStatus {
  return Object.hasOwn(member, 'status')
}

function memberInitial(
  member: OfficeMember | OfficeMemberWithStatus,
): string {
  return (
    Array.from(member.name.trim())[0] ??
    Array.from(member.email)[0]?.toUpperCase() ??
    '?'
  )
}

function InviteModal() {
  const { state, dispatch } = useInbox()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (state.inviteOpen) setError(null)
  }, [state.inviteOpen])

  if (!state.inviteOpen) return null

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSending(true)
    setError(null)
    try {
      const { member } = await inviteOfficeMember({
        email: state.inviteEmail,
        role: state.inviteRole,
      })
      dispatch({ type: 'upsertTeamMember', member })
      dispatch({ type: 'closeInvite' })
    } catch (failure: unknown) {
      setError(
        errorMessage(failure, '직원 초대를 보내지 못했습니다.'),
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <div
        className="absolute inset-0 z-[80] bg-ink/45"
        onClick={() => dispatch({ type: 'closeInvite' })}
      />
      <form
        onSubmit={(event) => void send(event)}
        className="absolute z-[90] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[calc(100%-32px)] bg-white rounded-2xl shadow-[0_24px_56px_rgba(16,24,40,.3)] p-[22px]"
      >
        <div className="flex items-center mb-1">
          <span className="text-[17px] font-bold tracking-[-0.3px]">
            직원 초대
          </span>
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

        <label
          htmlFor="invite-email"
          className="block text-[12.5px] font-semibold text-ink-700 mb-[7px]"
        >
          이메일
        </label>
        <input
          id="invite-email"
          value={state.inviteEmail}
          onChange={(event) =>
            dispatch({
              type: 'setInviteEmail',
              value: event.target.value,
            })
          }
          placeholder="name@rich.kr"
          className="w-full text-sm text-ink border border-line-strong rounded-[9px] px-3 py-2.5 outline-none focus:border-brand"
        />

        <div className="text-[12.5px] font-semibold text-ink-700 mt-4 mb-2">
          권한
        </div>
        <div className="flex flex-col gap-2">
          {INVITE_ROLES.map((role) => {
            const on = state.inviteRole === role
            return (
              <button
                key={role}
                type="button"
                onClick={() =>
                  dispatch({ type: 'setInviteRole', value: role })
                }
                className={`flex items-center gap-2.5 px-3 py-[11px] rounded-[10px] text-left border ${
                  on
                    ? 'border-brand bg-brand-50'
                    : 'border-line bg-white'
                }`}
              >
                <span
                  className={`w-4 h-4 flex-none rounded-full ${
                    on
                      ? 'border-[5px] border-brand'
                      : 'border-[1.5px] border-line-soft'
                  }`}
                />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold">
                    {role}
                  </span>
                  <span className="block text-[12.5px] text-ink-400">
                    {ROLE_DESCRIPTION[role]}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        {error && (
          <div
            role="alert"
            className="mt-3 rounded-lg bg-open-bg px-3 py-2 text-[12.5px] text-open-fg"
          >
            {error}
          </div>
        )}

        <div className="mt-5 flex gap-2 justify-end">
          <button
            type="button"
            disabled={sending}
            onClick={() => dispatch({ type: 'closeInvite' })}
            className="h-9 px-3.5 border border-line-strong rounded-[9px] flex items-center text-[13.5px] font-medium text-ink-600"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={sending}
            className="h-9 px-4 rounded-[9px] flex items-center text-[13.5px] font-semibold text-white bg-brand hover:bg-brand-hover disabled:bg-line-soft"
          >
            {sending ? '보내는 중…' : '초대 보내기'}
          </button>
        </div>
      </form>
    </>
  )
}

function ForbiddenOfficeSettings() {
  return (
    <main className="flex-1 min-w-0 flex items-center justify-center bg-surface px-6">
      <div className="max-w-md rounded-xl border border-line bg-white px-8 py-10 text-center shadow-[0_1px_2px_rgba(16,24,40,.04)]">
        <div className="text-[28px] font-bold text-ink">403</div>
        <div className="mt-2 text-[16px] font-bold">
          사무소 설정에 접근할 수 없습니다
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          관리자만 사무소 정책과 직원 초대를 변경할 수 있습니다.
        </p>
      </div>
    </main>
  )
}

export function OfficeSettings() {
  const { state, dispatch } = useInbox()
  const { me } = useAuth()
  const [settings, setSettings] =
    useState<SavedOfficeSettings | null>(null)
  const [retentionDraft, setRetentionDraft] = useState('')
  const [loading, setLoading] = useState(me.isAdmin)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!me.isAdmin) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    getOfficeSettings(controller.signal)
      .then(({ settings: loaded }) => {
        setSettings(loaded)
        setRetentionDraft(String(loaded.retentionYears))
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setError(
          errorMessage(
            failure,
            '사무소 설정을 불러오지 못했습니다.',
          ),
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [me.isAdmin])

  if (!me.isAdmin) return <ForbiddenOfficeSettings />

  const savePatch = async (
    optimistic: SavedOfficeSettings,
    patch: { exportLog?: boolean; retentionYears?: number },
  ) => {
    if (!settings || saving) return
    const previous = settings
    setSettings(optimistic)
    setSaving(true)
    setError(null)
    try {
      const { settings: saved } = await updateOfficeSettings(patch)
      setSettings(saved)
      setRetentionDraft(String(saved.retentionYears))
    } catch (failure: unknown) {
      setSettings(previous)
      setRetentionDraft(String(previous.retentionYears))
      setError(
        errorMessage(
          failure,
          '사무소 설정을 저장하지 못했습니다.',
        ),
      )
    } finally {
      setSaving(false)
    }
  }

  const saveRetention = () => {
    if (!settings) return
    const retentionYears = Number(retentionDraft)
    void savePatch(
      { ...settings, retentionYears },
      { retentionYears },
    )
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-white relative">
      <div className="h-[66px] flex-none px-6 border-b border-line flex items-center gap-2.5">
        <span className="text-[19px] font-bold tracking-[-0.4px]">
          사무소 설정
        </span>
        <span className="text-[11.5px] font-bold text-purple-fg bg-purple-soft rounded-[5px] px-2 py-0.5">
          관리자
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-[22px] bg-surface">
        <div className="max-w-[760px] flex flex-col gap-4">
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-danger-border bg-open-bg px-3.5 py-2.5 text-[13px] text-open-fg"
            >
              {error}
            </div>
          )}

          <Card className="p-[18px]">
            <div className="text-sm font-bold mb-1">문자 연동</div>
            <div className="text-[12.5px] text-ink-400 mb-3.5">
              LGU+ 메시지허브를 통해 고객 문자를 한 인박스에서
              주고받습니다
            </div>
            <div className="flex flex-col gap-[9px]">
              {CONNECTIONS.map((connection) => (
                <div
                  key={connection.name}
                  className="flex items-center gap-[11px] px-[13px] py-3 border border-line rounded-[10px]"
                >
                  <span
                    className={`w-2.5 h-2.5 rounded-[3px] flex-none ${connection.dot}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold">
                      {connection.name}
                    </span>
                    <span className="block text-xs text-ink-400">
                      {connection.sub}
                    </span>
                  </span>
                  <span className="ml-auto text-[11.5px] font-semibold text-done-fg bg-done-bg rounded-[5px] px-2 py-0.5">
                    {connection.state}
                  </span>
                  <button
                    type="button"
                    className="h-[30px] px-[11px] border border-line-strong rounded-lg flex items-center text-[12.5px] font-semibold text-ink-700 hover:border-brand hover:text-brand"
                  >
                    {connection.action}
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-[13px] px-[13px] py-3 rounded-[10px] bg-surface-sunken flex items-center gap-2.5">
              <span className="text-[12.5px] text-ink-600">
                이번 달 발송
              </span>
              <span className="text-[13.5px] font-bold">3,182건</span>
              <span className="text-[12.5px] text-ink-400">
                / 20,000건
              </span>
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
            {state.teamLoading && (
              <div className="py-8 text-center text-[13px] text-ink-400">
                직원 목록을 불러오고 있습니다.
              </div>
            )}
            {state.teamError && (
              <div
                role="alert"
                className="py-6 text-center text-[13px] text-open-fg"
              >
                {state.teamError}
              </div>
            )}
            {!state.teamLoading && !state.teamError && (
              <div className="flex flex-col gap-[9px]">
                {state.team.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center gap-[11px] px-[13px] py-[11px] border border-line rounded-[10px]"
                  >
                    <Avatar
                      initial={memberInitial(member)}
                      className={`w-8 h-8 text-xs ${
                        hasStatus(member) && member.status === '초대'
                          ? 'opacity-55'
                          : ''
                      }`}
                    />
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-semibold">
                        {member.name}
                      </span>
                      <span className="block text-xs text-ink-400">
                        {member.email}
                      </span>
                    </span>
                    {hasStatus(member) && member.status === '초대' && (
                      <span className="text-[11.5px] font-semibold text-doing-fg bg-doing-bg rounded-[5px] px-2 py-0.5">
                        초대 발송됨
                      </span>
                    )}
                    <span className="ml-auto text-[12.5px] text-ink-600 bg-fill rounded-md px-2.5 py-1 font-semibold">
                      {member.role}
                    </span>
                    {hasStatus(member) && (
                      <span className="text-[12.5px] text-ink-400">
                        {member.status}
                      </span>
                    )}
                  </div>
                ))}
                {state.team.length === 0 && (
                  <div className="py-8 text-center text-[13px] text-ink-400">
                    등록된 직원이 없습니다.
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card className="p-[18px]">
            <div className="text-sm font-bold mb-3.5">
              AI · 데이터 정책
            </div>
            <div className="flex flex-col gap-1">
              {OFFICE_TOGGLES.map((toggle) => (
                <ToggleRow
                  key={toggle.key}
                  name={toggle.name}
                  sub={toggle.sub}
                  on={state.office[toggle.key]}
                  onFlip={() =>
                    dispatch({
                      type: 'toggleOffice',
                      key: toggle.key,
                    })
                  }
                />
              ))}
              {settings && (
                <ToggleRow
                  name="대화 내보내기 기록"
                  sub="누가 언제 대화를 내보냈는지 남깁니다"
                  on={settings.exportLog}
                  onFlip={() =>
                    void savePatch(
                      {
                        ...settings,
                        exportLog: !settings.exportLog,
                      },
                      { exportLog: !settings.exportLog },
                    )
                  }
                />
              )}
            </div>
            <div className="mt-[13px] pt-[13px] border-t border-fill flex items-center gap-3">
              <span className="min-w-0">
                <label
                  htmlFor="retention-years"
                  className="block text-[13.5px] font-semibold"
                >
                  대화 보존 기간
                </label>
                <span
                  id="retention-years-help"
                  className="block text-[12.5px] text-ink-400"
                >
                  {RETENTION_YEARS_MIN}~{RETENTION_YEARS_MAX}년 사이의
                  정수를 입력해 주세요
                </span>
              </span>
              {loading ? (
                <span className="ml-auto text-[12.5px] text-ink-400">
                  불러오는 중…
                </span>
              ) : (
                <div className="ml-auto flex items-center gap-2">
                  <div className="flex items-center">
                    <input
                      id="retention-years"
                      inputMode="numeric"
                      aria-describedby="retention-years-help"
                      value={retentionDraft}
                      onChange={(event) =>
                        setRetentionDraft(event.target.value)
                      }
                      className="w-20 h-8 border border-line-strong rounded-l-lg px-2.5 text-right text-[13px] font-semibold text-ink-700 outline-none focus:border-brand"
                    />
                    <span className="h-8 border-y border-r border-line-strong rounded-r-lg px-2 flex items-center text-[13px] text-ink-500">
                      년
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={!settings || saving}
                    onClick={saveRetention}
                    className="h-8 px-3 rounded-lg bg-brand text-[12.5px] font-semibold text-white hover:bg-brand-hover disabled:bg-line-soft"
                  >
                    {saving ? '저장 중…' : '저장'}
                  </button>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <InviteModal />
    </div>
  )
}
