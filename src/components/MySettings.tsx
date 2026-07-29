import { useEffect, useState } from 'react'
import { useAuth } from '../api/AuthGate'
import {
  logout,
  updateMe,
  updateMeSettings,
  type MeResponse,
  type UserSettingField,
  type UserSettings,
} from '../api/endpoints'
import { useInbox } from '../state/InboxContext'
import type { AiSettings } from '../state/inbox'
import { Card, ToggleRow } from './ui'

type ProfileDraft = Pick<MeResponse['user'], 'name' | 'title' | 'email'>

function profileDraftFrom(me: MeResponse): ProfileDraft {
  return {
    name: me.user.name,
    title: me.user.title,
    email: me.user.email,
  }
}

const PROFILE_FIELDS: Array<{
  key: keyof ProfileDraft
  label: string
  readOnly: boolean
}> = [
  { key: 'name', label: '이름', readOnly: false },
  { key: 'title', label: '직함', readOnly: true },
  { key: 'email', label: '이메일', readOnly: true },
]

const NOTIFY_TOGGLES: Array<{
  key: UserSettingField
  name: string
  sub: string
}> = [
  {
    key: 'notifyNewChat',
    name: '새 대화 알림',
    sub: '미배정 대화가 들어오면 알립니다',
  },
  {
    key: 'notifyMineOnly',
    name: '내 담당만 알림',
    sub: '내가 담당인 대화의 새 메시지만 알립니다',
  },
  {
    key: 'notifySound',
    name: '알림음',
    sub: '데스크톱 알림에 소리를 함께 재생합니다',
  },
]

const AI_TOGGLES: { key: keyof AiSettings; name: string; sub: string }[] = [
  { key: 'summary', name: '대화 요약 자동 생성', sub: '새 메시지가 오면 요약을 갱신합니다' },
  { key: 'autofill', name: '세무 정보 자동 입력', sub: '연결된 폴더 문서를 읽어 빈 항목을 채웁니다' },
  { key: 'draft', name: '답장 초안 자동 제안', sub: '고객 문의가 오면 초안을 미리 만들어 둡니다' },
]

export function MySettings() {
  const { state, dispatch } = useInbox()
  const { me, applyMeResponse, completeLogout } = useAuth()
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(
    profileDraftFrom(me),
  )
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMessage, setProfileMessage] = useState<string | null>(
    null,
  )
  const [notify, setNotify] = useState<UserSettings>(me.settings)
  const [notifySaving, setNotifySaving] = useState(false)
  const [notifyError, setNotifyError] = useState<string | null>(null)
  const [logoutPending, setLogoutPending] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  useEffect(() => {
    setProfileDraft(profileDraftFrom(me))
    setNotify(me.settings)
  }, [me])

  const saveProfile = async () => {
    const optimistic = { ...profileDraft }
    setProfileSaving(true)
    setProfileMessage(null)
    try {
      const response = await updateMe({
        name: optimistic.name,
      })
      applyMeResponse(response)
      setProfileDraft(profileDraftFrom(response))
      setProfileMessage('저장했습니다.')
    } catch (error: unknown) {
      setProfileDraft(profileDraftFrom(me))
      setProfileMessage(
        error instanceof Error
          ? error.message
          : '프로필을 저장하지 못했습니다.',
      )
    } finally {
      setProfileSaving(false)
    }
  }

  const flipNotify = async (key: UserSettingField) => {
    if (notifySaving) return
    const previous = notify
    const nextValue = !previous[key]
    setNotify({ ...previous, [key]: nextValue })
    setNotifySaving(true)
    setNotifyError(null)
    try {
      const response = await updateMeSettings({ [key]: nextValue })
      applyMeResponse(response)
      setNotify(response.settings)
    } catch (error: unknown) {
      setNotify(previous)
      setNotifyError(
        error instanceof Error
          ? error.message
          : '알림 설정을 저장하지 못했습니다.',
      )
    } finally {
      setNotifySaving(false)
    }
  }

  const logOut = async () => {
    if (logoutPending) return
    setLogoutPending(true)
    setLogoutError(null)
    try {
      await logout()
      completeLogout()
    } catch (error: unknown) {
      setLogoutPending(false)
      setLogoutError(
        error instanceof Error
          ? error.message
          : '로그아웃하지 못했습니다.',
      )
    }
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-white">
      <div className="h-[66px] flex-none px-6 border-b border-line flex items-center">
        <span className="text-[19px] font-bold tracking-[-0.4px]">내 설정</span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-[22px] bg-surface">
        <div className="max-w-[640px] flex flex-col gap-4">
          <Card className="p-[18px]">
            <div className="text-sm font-bold mb-3.5">프로필</div>
            <div className="flex items-center gap-3.5 mb-4">
              <div className="w-14 h-14 flex-none rounded-full bg-brand-200 text-brand-text flex items-center justify-center text-[21px] font-bold">
                {me.user.name[0]}
              </div>
              <button
                type="button"
                className="h-8 px-3 border border-line-strong rounded-lg flex items-center text-[12.5px] font-semibold text-ink-700 hover:border-brand hover:text-brand"
              >
                사진 변경
              </button>
              <button type="button" className="text-[12.5px] text-ink-400">
                삭제
              </button>
            </div>

            <div className="flex flex-col gap-3">
              {PROFILE_FIELDS.map((p) => (
                <div key={p.key} className="flex items-center gap-3">
                  <span className="w-24 flex-none text-[13px] text-ink-500">{p.label}</span>
                  <input
                    value={profileDraft[p.key]}
                    readOnly={p.readOnly}
                    onChange={
                      p.readOnly
                        ? undefined
                        : (event) =>
                            setProfileDraft((current) => ({
                              ...current,
                              [p.key]: event.target.value,
                            }))
                    }
                    className={`flex-1 min-w-0 text-[13.5px] border border-line-strong rounded-lg px-[11px] py-2 outline-none ${
                      p.readOnly
                        ? 'text-ink-500 bg-fill cursor-not-allowed'
                        : 'text-ink focus:border-brand'
                    }`}
                  />
                </div>
              ))}
            </div>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={profileSaving}
                onClick={() => void saveProfile()}
                className="h-[34px] px-4 rounded-[9px] bg-brand text-white flex items-center text-[13.5px] font-semibold hover:bg-brand-hover"
              >
                {profileSaving ? '저장 중…' : '저장'}
              </button>
              <button
                type="button"
                disabled={profileSaving}
                onClick={() => {
                  setProfileDraft(profileDraftFrom(me))
                  setProfileMessage(null)
                }}
                className="h-[34px] px-3.5 border border-line-strong rounded-[9px] flex items-center text-[13.5px] font-medium text-ink-600"
              >
                취소
              </button>
              {profileMessage && (
                <span
                  role="status"
                  className="self-center text-[12.5px] text-ink-500"
                >
                  {profileMessage}
                </span>
              )}
            </div>
          </Card>

          <Card className="p-[18px]">
            <div className="text-sm font-bold mb-3.5">알림</div>
            <fieldset
              disabled={notifySaving}
              className={notifySaving ? 'opacity-70' : ''}
            >
              <div className="flex flex-col gap-1">
                {NOTIFY_TOGGLES.map((t) => (
                  <ToggleRow
                    key={t.key}
                    name={t.name}
                    sub={t.sub}
                    on={notify[t.key]}
                    onFlip={() => void flipNotify(t.key)}
                  />
                ))}
              </div>
            </fieldset>
            {notifyError && (
              <div role="alert" className="mt-2 text-[12.5px] text-open-fg">
                {notifyError}
              </div>
            )}
          </Card>

          <Card className="p-[18px]">
            <div className="text-sm font-bold mb-3.5">내 AI 설정</div>
            <div className="flex flex-col gap-1">
              {AI_TOGGLES.map((t) => (
                <ToggleRow
                  key={t.key}
                  name={t.name}
                  sub={t.sub}
                  on={state.ai[t.key]}
                  onFlip={() => dispatch({ type: 'toggleAi', key: t.key })}
                />
              ))}
            </div>
          </Card>

          <Card className="p-[18px]">
            <div className="flex items-center gap-3">
              <div>
                <div className="text-[13.5px] font-semibold">로그아웃</div>
                <div className="text-[12.5px] text-ink-400">이 기기에서 계정 연결을 해제합니다</div>
              </div>
              <button
                type="button"
                disabled={logoutPending}
                onClick={() => void logOut()}
                className="ml-auto h-[34px] px-3.5 border border-danger-border rounded-[9px] flex items-center text-[13.5px] font-semibold text-open-fg hover:bg-open-bg disabled:cursor-wait disabled:opacity-60"
              >
                {logoutPending ? '로그아웃 중…' : '로그아웃'}
              </button>
            </div>
            {logoutError && (
              <div role="alert" className="mt-2 text-[12.5px] text-open-fg">
                {logoutError}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
