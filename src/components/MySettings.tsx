import { useInbox } from '../state/InboxContext'
import type { AiSettings, NotifySettings } from '../state/inbox'
import type { Profile } from '../types'
import { Card, ToggleRow } from './ui'

const PROFILE_FIELDS: { key: keyof Profile; label: string }[] = [
  { key: 'name', label: '이름' },
  { key: 'title', label: '직함' },
  { key: 'email', label: '이메일' },
  { key: 'phone', label: '연락처' },
]

const NOTIFY_TOGGLES: { key: keyof NotifySettings; name: string; sub: string }[] = [
  { key: 'newChat', name: '새 대화 알림', sub: '미배정 대화가 들어오면 알립니다' },
  { key: 'mineOnly', name: '내 담당만 알림', sub: '내가 담당인 대화의 새 메시지만 알립니다' },
  { key: 'sound', name: '알림음', sub: '데스크톱 알림에 소리를 함께 재생합니다' },
]

const AI_TOGGLES: { key: keyof AiSettings; name: string; sub: string }[] = [
  { key: 'summary', name: '대화 요약 자동 생성', sub: '새 메시지가 오면 요약을 갱신합니다' },
  { key: 'autofill', name: '세무 정보 자동 입력', sub: '연결된 폴더 문서를 읽어 빈 항목을 채웁니다' },
  { key: 'draft', name: '답장 초안 자동 제안', sub: '고객 문의가 오면 초안을 미리 만들어 둡니다' },
]

export function MySettings() {
  const { state, dispatch } = useInbox()

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
                {state.profile.name[0]}
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
                    value={state.profile[p.key]}
                    onChange={(e) =>
                      dispatch({ type: 'setProfile', key: p.key, value: e.target.value })
                    }
                    className="flex-1 min-w-0 text-[13.5px] text-ink border border-line-strong rounded-lg px-[11px] py-2 outline-none focus:border-brand"
                  />
                </div>
              ))}
              <div className="flex items-start gap-3">
                <span className="w-24 flex-none text-[13px] text-ink-500 pt-2">답장 서명</span>
                <textarea
                  value={state.profile.signature}
                  onChange={(e) =>
                    dispatch({ type: 'setProfile', key: 'signature', value: e.target.value })
                  }
                  placeholder="예: 세무법인 리치 박상담 드림"
                  className="flex-1 min-w-0 h-16 resize-none text-[13.5px] text-ink border border-line-strong rounded-lg px-[11px] py-[9px] outline-none focus:border-brand font-sans leading-normal"
                />
              </div>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="h-[34px] px-4 rounded-[9px] bg-brand text-white flex items-center text-[13.5px] font-semibold hover:bg-brand-hover"
              >
                저장
              </button>
              <button
                type="button"
                className="h-[34px] px-3.5 border border-line-strong rounded-[9px] flex items-center text-[13.5px] font-medium text-ink-600"
              >
                취소
              </button>
            </div>
          </Card>

          <Card className="p-[18px]">
            <div className="text-sm font-bold mb-3.5">알림</div>
            <div className="flex flex-col gap-1">
              {NOTIFY_TOGGLES.map((t) => (
                <ToggleRow
                  key={t.key}
                  name={t.name}
                  sub={t.sub}
                  on={state.notify[t.key]}
                  onFlip={() => dispatch({ type: 'toggleNotify', key: t.key })}
                />
              ))}
            </div>
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

          <Card className="p-[18px] flex items-center gap-3">
            <div>
              <div className="text-[13.5px] font-semibold">로그아웃</div>
              <div className="text-[12.5px] text-ink-400">이 기기에서 계정 연결을 해제합니다</div>
            </div>
            <button
              type="button"
              className="ml-auto h-[34px] px-3.5 border border-danger-border rounded-[9px] flex items-center text-[13.5px] font-semibold text-open-fg hover:bg-open-bg"
            >
              로그아웃
            </button>
          </Card>
        </div>
      </div>
    </div>
  )
}
