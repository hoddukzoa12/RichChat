import { useInbox } from '../../state/InboxContext'
import { ME } from '../../data/seed'
import type { TaskDraft } from '../../types'
import { Avatar, Card } from '../ui'

const BADGE_OPTIONS: { key: TaskDraft['kind']; label: string }[] = [
  { key: 'warn', label: '진행 중' },
  { key: 'idle', label: '대기' },
  { key: 'done', label: '완료' },
]

const inputClass =
  'w-full text-[13.5px] text-ink border border-line-strong rounded-[7px] px-2 py-[5px] outline-none focus:border-brand'

function TaskForm() {
  const { state, dispatch } = useInbox()
  const d = state.taskDraft
  const editing = state.taskEdit !== null

  return (
    <div className="border border-brand rounded-[9px] px-[11px] py-2.5 bg-brand-50">
      <input
        value={d.name}
        onChange={(e) => dispatch({ type: 'setTaskDraft', patch: { name: e.target.value } })}
        placeholder="업무 이름"
        className={`${inputClass} font-semibold mb-1.5`}
      />
      <input
        value={d.sub}
        onChange={(e) => dispatch({ type: 'setTaskDraft', patch: { sub: e.target.value } })}
        placeholder="기한 · 메모"
        className={`${inputClass} text-[12.5px] text-ink-700`}
      />
      <div className="mt-2 flex gap-[5px]">
        {BADGE_OPTIONS.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => dispatch({ type: 'setTaskDraft', patch: { kind: b.key } })}
            className={`px-[11px] py-1 rounded-[14px] text-xs font-semibold border ${
              d.kind === b.key
                ? 'border-brand text-brand-text bg-brand-100'
                : 'border-line-strong text-ink-500 bg-white'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div className="mt-[9px] flex gap-1.5">
        <button
          type="button"
          onClick={() => dispatch({ type: 'saveTask' })}
          className="h-7 px-3 rounded-lg bg-brand text-white flex items-center text-[12.5px] font-semibold"
        >
          저장
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'cancelTask' })}
          className="h-7 px-2.5 border border-line-strong rounded-lg bg-white flex items-center text-[12.5px] text-ink-600"
        >
          취소
        </button>
        {editing && (
          <button
            type="button"
            onClick={() => dispatch({ type: 'removeTask', index: state.taskEdit! })}
            className="ml-auto h-7 px-2.5 flex items-center text-[12.5px] text-open-fg"
          >
            삭제
          </button>
        )}
      </div>
    </div>
  )
}

function NoteForm() {
  const { state, dispatch } = useInbox()
  const editing = state.noteEdit !== null

  return (
    <div className={editing ? 'mt-[5px]' : 'mt-[11px]'}>
      <input
        value={state.noteDraft}
        onChange={(e) => dispatch({ type: 'setNoteDraft', value: e.target.value })}
        placeholder="메모를 입력하세요"
        className="w-full text-[13.5px] text-ink border border-brand rounded-lg px-2.5 py-2 outline-none"
      />
      <div className="mt-[7px] flex gap-1.5">
        <button
          type="button"
          onClick={() => dispatch({ type: 'saveNote', now: Date.now() })}
          className="h-7 px-3 rounded-lg bg-brand text-white flex items-center text-[12.5px] font-semibold"
        >
          저장
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'cancelNote' })}
          className="h-7 px-2.5 border border-line-strong rounded-lg flex items-center text-[12.5px] text-ink-600"
        >
          취소
        </button>
        {editing && (
          <button
            type="button"
            onClick={() => dispatch({ type: 'removeNote', index: state.noteEdit! })}
            className="ml-auto h-7 px-2.5 rounded-lg flex items-center text-[12.5px] text-open-fg"
          >
            삭제
          </button>
        )}
      </div>
    </div>
  )
}

export function InfoTab() {
  const { state, dispatch, cur } = useInbox()
  const edit = state.editDraft
  const fields = edit ? edit.fields : cur.fields

  return (
    <>
      <Card className="px-[15px] pt-4 pb-3.5">
        <div className="flex items-center gap-3 pb-3.5 border-b border-fill mb-[13px]">
          <Avatar initial={cur.initial} className="w-[46px] h-[46px] text-lg" />
          <div className="min-w-0 flex-1">
            {edit ? (
              <>
                <input
                  value={edit.name}
                  onChange={(e) => dispatch({ type: 'setEditName', value: e.target.value })}
                  placeholder="고객명"
                  className={`${inputClass} text-sm font-semibold mb-[5px]`}
                />
                <input
                  value={edit.org}
                  onChange={(e) => dispatch({ type: 'setEditOrg', value: e.target.value })}
                  placeholder="상호 · 직함"
                  className={`${inputClass} text-[12.5px] text-ink-700`}
                />
              </>
            ) : (
              <>
                <div className="text-base font-bold tracking-[-0.3px]">{cur.name}</div>
                <div className="text-[12.5px] text-ink-500 truncate">{cur.orgLine}</div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-[7px] mb-[11px]">
          <span className="text-[13px] font-bold">세무 정보</span>
          <span className="text-[10.5px] font-semibold text-brand-text bg-brand-100 rounded px-1.5 py-[1.5px]">
            AI 자동 입력
          </span>
          <span className="ml-auto text-[11.5px] text-ink-400">수정 가능</span>
        </div>

        <div className="flex flex-col gap-[9px]">
          {fields.map((f, i) => (
            <div key={f.k} className="flex items-center gap-2.5">
              <span className="w-[78px] flex-none text-[12.5px] text-ink-500">{f.k}</span>
              {edit ? (
                <input
                  value={f.v}
                  onChange={(e) =>
                    dispatch({ type: 'setEditField', index: i, value: e.target.value })
                  }
                  className={`${inputClass} flex-1 min-w-0 font-medium`}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'startEdit' })}
                  className="flex-1 text-left text-[13.5px] font-medium border-b border-dashed border-line-soft pb-0.5 cursor-text hover:border-brand hover:text-brand"
                >
                  {f.v}
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="px-[15px] py-3.5">
        <div className="flex items-center mb-2.5">
          <span className="text-[13px] font-bold">진행 중인 업무</span>
          {!state.addingTask && state.taskEdit === null && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'addTask' })}
              className="ml-auto text-[12.5px] text-brand font-semibold"
            >
              ＋ 추가
            </button>
          )}
        </div>
        <div className="flex flex-col gap-[7px]">
          {cur.tasks.map((t, i) =>
            state.taskEdit === i ? (
              <TaskForm key={i} />
            ) : (
              <div
                key={i}
                className={`rounded-[9px] px-[11px] py-2.5 border ${
                  t.kind === 'warn' ? 'border-warn-border bg-warn-bg' : 'border-line'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[13.5px] font-semibold">{t.name}</span>
                  <span
                    className={`ml-auto text-[11px] rounded px-1.5 py-px ${
                      t.kind === 'warn'
                        ? 'font-bold text-doing-fg bg-kakao-bg'
                        : 'font-semibold text-ink-600 bg-fill'
                    }`}
                  >
                    {t.badge}
                  </span>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'editTask', index: i })}
                    className="ml-2 text-[11.5px] text-brand font-semibold"
                  >
                    수정
                  </button>
                </div>
                <div className="text-[12.5px] text-ink-500 mt-[3px]">{t.sub}</div>
              </div>
            ),
          )}
          {state.addingTask && <TaskForm />}
        </div>
      </Card>

      <Card className="px-[15px] py-3.5">
        <div className="flex items-center mb-[11px]">
          <span className="text-[13px] font-bold">고객 메모</span>
          <span className="ml-auto text-[11.5px] text-ink-400">직원에게만 보임</span>
        </div>
        <div className="flex flex-col gap-[11px]">
          {cur.notes.map((n, i) => (
            <div key={i} className="flex gap-[9px]">
              <Avatar initial={n.author[0]} className="w-[26px] h-[26px] text-[11px]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] font-semibold">{n.author}</span>
                  <span className="text-[11.5px] text-ink-400">{n.time}</span>
                  {state.noteEdit !== i && n.author === ME && (
                    <button
                      type="button"
                      onClick={() => dispatch({ type: 'editNote', index: i })}
                      className="ml-auto text-[11.5px] text-brand font-semibold"
                    >
                      수정
                    </button>
                  )}
                </div>
                {state.noteEdit === i ? (
                  <NoteForm />
                ) : (
                  <div className="mt-[3px] text-[13.5px] text-ink-700 leading-[1.55]">{n.text}</div>
                )}
              </div>
            </div>
          ))}
        </div>
        {state.addingNote ? (
          <NoteForm />
        ) : (
          <button
            type="button"
            onClick={() => dispatch({ type: 'addNote' })}
            className="mt-[11px] w-full h-8 border border-dashed border-line-soft rounded-lg flex items-center justify-center text-[12.5px] text-ink-500 hover:border-brand hover:text-brand"
          >
            ＋ 메모 추가
          </button>
        )}
      </Card>
    </>
  )
}
