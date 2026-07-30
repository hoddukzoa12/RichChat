import { useEffect, useState, type FormEvent } from 'react'
import { ROLES } from '../../shared/domain'
import { useAuth } from '../api/AuthGate'
import {
  getOfficeSettings,
  inviteOfficeMember,
  RETENTION_YEARS_MAX,
  RETENTION_YEARS_MIN,
  updateOfficeMember,
  updateOfficeMemberStatus,
  updateOfficeSettings,
  type MemberStatus,
  type OfficeMember,
  type OfficeMemberWithStatus,
  type OfficeSettings as SavedOfficeSettings,
} from '../api/endpoints'
import { useInbox } from '../state/InboxContext'
import type { OfficeSettings as OfficeFlags } from '../state/inbox'
import { MEMBER_STATUS_VIEW } from '../theme'
import type { Role, UserStatus } from '../types'
import { OfficePhonesCard } from './OfficePhonesCard'
import { Avatar, Card, ToggleRow } from './ui'

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

const ROLE_DESCRIPTION: Record<Role, string> = {
  관리자: '모든 사무소 설정과 직원 권한을 관리합니다',
  부관리자: '직원을 관리하되 관리자 지정은 할 수 없습니다',
  '상담 담당': '대화 응대와 고객 정보 편집',
  세무사: '담당 고객 대화 확인과 응대',
}

const MEMBER_STATUS_ACTION: Record<
  UserStatus,
  { label: string; target: MemberStatus }
> = {
  초대: { label: '비활성화', target: '비활성' },
  활성: { label: '비활성화', target: '비활성' },
  비활성: { label: '재활성화', target: '활성' },
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
        name: state.inviteName,
        title: state.inviteTitle,
        role: state.inviteRole,
      })
      dispatch({ type: 'upsertTeamMember', member })
      dispatch({ type: 'closeInvite' })
    } catch (failure: unknown) {
      setError(
        errorMessage(failure, '직원을 초대하지 못했습니다.'),
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
        className="absolute z-[90] top-1/2 left-1/2 max-h-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[calc(100%-32px)] overflow-y-auto bg-white rounded-2xl shadow-[0_24px_56px_rgba(16,24,40,.3)] p-[22px]"
      >
        <div className="flex items-center mb-1">
          <span className="text-[17px] font-bold tracking-[-0.3px]">
            직원 초대
          </span>
          <button
            type="button"
            aria-label="직원 초대 닫기"
            onClick={() => dispatch({ type: 'closeInvite' })}
            className="ml-auto text-[17px] text-ink-400"
          >
            ✕
          </button>
        </div>
        <div className="text-[13px] text-ink-400 mb-[18px]">
          직원 정보를 등록하고 인박스 초대 상태로 추가합니다
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-semibold text-ink-700 mb-[7px]">
              이름
            </span>
            <input
              required
              value={state.inviteName}
              onChange={(event) =>
                dispatch({
                  type: 'setInviteName',
                  value: event.target.value,
                })
              }
              placeholder="김리치"
              className="w-full text-sm text-ink border border-line-strong rounded-[9px] px-3 py-2.5 outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-semibold text-ink-700 mb-[7px]">
              직함
            </span>
            <input
              required
              value={state.inviteTitle}
              onChange={(event) =>
                dispatch({
                  type: 'setInviteTitle',
                  value: event.target.value,
                })
              }
              placeholder="세무사"
              className="w-full text-sm text-ink border border-line-strong rounded-[9px] px-3 py-2.5 outline-none focus:border-brand"
            />
          </label>
        </div>

        <label
          htmlFor="invite-email"
          className="block text-[12.5px] font-semibold text-ink-700 mt-4 mb-[7px]"
        >
          이메일
        </label>
        <input
          id="invite-email"
          type="email"
          required
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
          역할
        </div>
        <div className="flex flex-col gap-2">
          {ROLES.map((role) => {
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
                } disabled:cursor-not-allowed disabled:opacity-45`}
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
            {sending ? '초대 중…' : '초대하기'}
          </button>
        </div>
      </form>
    </>
  )
}

function EditMemberModal({
  member,
  onClose,
  onSaved,
}: {
  member: OfficeMember | OfficeMemberWithStatus
  onClose: () => void
  onSaved: (member: OfficeMemberWithStatus) => void
}) {
  const [name, setName] = useState(member.name)
  const [title, setTitle] = useState(member.title)
  const [role, setRole] = useState(member.role)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid =
    name.trim() !== '' &&
    title.trim() !== ''

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      const response = await updateOfficeMember(member.id, {
        name,
        title,
        role,
      })
      onSaved(response.member)
    } catch (failure: unknown) {
      setError(
        errorMessage(failure, '직원 정보를 저장하지 못했습니다.'),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="absolute inset-0 z-[80] bg-ink/45" onClick={onClose} />
      <form
        onSubmit={(event) => void save(event)}
        className="absolute z-[90] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[calc(100%-32px)] bg-white rounded-2xl shadow-[0_24px_56px_rgba(16,24,40,.3)] p-[22px]"
      >
        <div className="flex items-center mb-1">
          <span className="text-[17px] font-bold tracking-[-0.3px]">
            직원 정보 수정
          </span>
          <button
            type="button"
            aria-label="직원 정보 수정 닫기"
            onClick={onClose}
            className="ml-auto text-[17px] text-ink-400"
          >
            ✕
          </button>
        </div>
        <div className="mb-[18px] text-[13px] text-ink-400">
          {member.email}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-semibold text-ink-700 mb-[7px]">
              이름
            </span>
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full text-sm text-ink border border-line-strong rounded-[9px] px-3 py-2.5 outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-semibold text-ink-700 mb-[7px]">
              직함
            </span>
            <input
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full text-sm text-ink border border-line-strong rounded-[9px] px-3 py-2.5 outline-none focus:border-brand"
            />
          </label>
        </div>

        <label
          htmlFor="member-role"
          className="block text-[12.5px] font-semibold text-ink-700 mt-4 mb-[7px]"
        >
          역할
        </label>
        <select
          id="member-role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          className="w-full text-sm text-ink border border-line-strong rounded-[9px] px-3 py-2.5 outline-none focus:border-brand"
        >
          {ROLES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
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
            disabled={saving}
            onClick={onClose}
            className="h-9 px-3.5 border border-line-strong rounded-[9px] flex items-center text-[13.5px] font-medium text-ink-600"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={saving || !valid}
            className="h-9 px-4 rounded-[9px] flex items-center text-[13.5px] font-semibold text-white bg-brand hover:bg-brand-hover disabled:bg-line-soft"
          >
            {saving ? '저장 중…' : '저장'}
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
          사무소 화면에 접근할 수 없습니다
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          이 계정에는 직원 목록을 볼 권한이 없습니다.
        </p>
      </div>
    </main>
  )
}

export function OfficeSettings() {
  const { state, dispatch } = useInbox()
  const { me } = useAuth()
  const canViewTeam = me.permissions['team:view']
  const canManageTeam = me.permissions['team:manage']
  const canManageOffice = me.permissions['office:manage']
  const [settings, setSettings] =
    useState<SavedOfficeSettings | null>(null)
  const [retentionDraft, setRetentionDraft] = useState('')
  const [loading, setLoading] = useState(canManageOffice)
  const [saving, setSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(
    null,
  )
  const [memberError, setMemberError] = useState<string | null>(null)
  const [memberPendingId, setMemberPendingId] = useState<string | null>(
    null,
  )
  const [editingMember, setEditingMember] = useState<
    OfficeMember | OfficeMemberWithStatus | null
  >(null)

  useEffect(() => {
    if (!canViewTeam || !canManageOffice) return
    const controller = new AbortController()
    setLoading(true)
    setSettingsError(null)
    getOfficeSettings(controller.signal)
      .then(({ settings: loaded }) => {
        setSettings(loaded)
        setRetentionDraft(String(loaded.retentionYears))
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setSettingsError(
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
  }, [canManageOffice, canViewTeam])

  if (!canViewTeam) return <ForbiddenOfficeSettings />

  const savePatch = async (
    optimistic: SavedOfficeSettings,
    patch: { exportLog?: boolean; retentionYears?: number },
  ) => {
    if (!settings || saving) return
    const previous = settings
    setSettings(optimistic)
    setSaving(true)
    setSettingsError(null)
    try {
      const { settings: saved } = await updateOfficeSettings(patch)
      setSettings(saved)
      setRetentionDraft(String(saved.retentionYears))
    } catch (failure: unknown) {
      setSettings(previous)
      setRetentionDraft(String(previous.retentionYears))
      setSettingsError(
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

  const changeMemberStatus = async (
    member: OfficeMemberWithStatus,
  ) => {
    const action = MEMBER_STATUS_ACTION[member.status]
    setMemberPendingId(member.id)
    setMemberError(null)
    try {
      const { member: saved } = await updateOfficeMemberStatus(
        member.id,
        { status: action.target },
      )
      dispatch({ type: 'upsertTeamMember', member: saved })
    } catch (failure: unknown) {
      setMemberError(
        errorMessage(
          failure,
          `${member.name} 직원을 ${action.label}하지 못했습니다.`,
        ),
      )
    } finally {
      setMemberPendingId(null)
    }
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-white relative">
      <div className="h-[66px] flex-none px-6 border-b border-line flex items-center gap-2.5">
        <span className="text-[19px] font-bold tracking-[-0.4px]">
          사무소 설정
        </span>
        <span className="text-[11.5px] font-bold text-purple-fg bg-purple-soft rounded-[5px] px-2 py-0.5">
          {me.user.role}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-[22px] bg-surface">
        <div className="max-w-[760px] flex flex-col gap-4">
          {canManageOffice && settingsError && (
            <div
              role="alert"
              className="rounded-lg border border-danger-border bg-open-bg px-3.5 py-2.5 text-[13px] text-open-fg"
            >
              {settingsError}
            </div>
          )}

          {canManageOffice && <OfficePhonesCard />}

          <Card className="p-[18px]">
            <div className="flex items-center mb-3.5">
              <span className="text-sm font-bold">직원 · 권한</span>
              {canManageTeam && (
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'openInvite' })}
                  className="ml-auto text-[12.5px] text-brand font-semibold"
                >
                  ＋ 초대
                </button>
              )}
            </div>
            {memberError && (
              <div
                role="alert"
                className="mb-3 rounded-lg bg-open-bg px-3 py-2 text-[12.5px] text-open-fg"
              >
                {memberError}
              </div>
            )}
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
                {state.team.map((member) => {
                  const statusView = hasStatus(member)
                    ? MEMBER_STATUS_VIEW[member.status]
                    : null
                  const statusAction = hasStatus(member)
                    ? MEMBER_STATUS_ACTION[member.status]
                    : null
                  const deactivates =
                    statusAction?.target === '비활성'
                  const blocksSelfDeactivation =
                    deactivates && member.id === me.user.id
                  const statusDisabled =
                    blocksSelfDeactivation ||
                    memberPendingId === member.id

                  return (
                    <div
                      key={member.id}
                      className={`flex items-center gap-[11px] px-[13px] py-[11px] border border-line rounded-[10px] ${statusView?.rowClass ?? ''}`}
                    >
                      <Avatar
                        initial={memberInitial(member)}
                        className={`w-8 h-8 text-xs ${statusView?.avatarClass ?? ''}`}
                      />
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-semibold">
                          {member.name}
                        </span>
                        <span className="block text-xs text-ink-400">
                          {member.title} · {member.email}
                        </span>
                      </span>
                      {statusView && (
                        <span
                          className={`text-[11.5px] font-semibold rounded-[5px] px-2 py-0.5 ${statusView.badgeClass}`}
                        >
                          {statusView.label}
                        </span>
                      )}
                      <span className="ml-auto text-[12.5px] text-ink-600 bg-fill rounded-md px-2.5 py-1 font-semibold">
                        {member.role}
                      </span>
                      {canManageTeam && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setMemberError(null)
                              setEditingMember(member)
                            }}
                            className="text-[12.5px] font-semibold text-brand disabled:cursor-not-allowed disabled:text-ink-300"
                          >
                            수정
                          </button>
                          {hasStatus(member) && statusAction && (
                            <button
                              type="button"
                              disabled={statusDisabled}
                              title={
                                blocksSelfDeactivation
                                  ? '자기 자신은 비활성화할 수 없습니다.'
                                  : undefined
                              }
                              onClick={() =>
                                void changeMemberStatus(member)
                              }
                              className="text-[12.5px] text-ink-500 disabled:cursor-not-allowed disabled:text-ink-300"
                            >
                              {memberPendingId === member.id
                                ? '처리 중…'
                                : statusAction.label}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
                {state.team.length === 0 && (
                  <div className="py-8 text-center text-[13px] text-ink-400">
                    등록된 직원이 없습니다.
                  </div>
                )}
              </div>
            )}
          </Card>

          {canManageOffice && (
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
          )}
        </div>
      </div>

      {canManageTeam && <InviteModal />}
      {editingMember && (
        <EditMemberModal
          key={editingMember.id}
          member={editingMember}
          onClose={() => setEditingMember(null)}
          onSaved={(member) => {
            dispatch({ type: 'upsertTeamMember', member })
            setEditingMember(null)
          }}
        />
      )}
    </div>
  )
}
