import type {
  CustomerCardDataAction,
  CustomerCardDataState,
} from '../../state/customerCardModel'
import { TASK_KINDS } from '../../../shared/domain'
import { formatCalendarDate, formatClockTime } from '../../lib/time'
import { TASK_KIND_VIEW } from '../../theme'
import { Avatar, Card } from '../ui'

const inputClass =
  'border border-line-strong rounded-[7px] px-2 py-[5px] outline-none focus:border-brand'

export interface InfoTabViewProps {
  conversationId: string
  data: CustomerCardDataState
  sessionUserId: string
  dispatchData: (action: CustomerCardDataAction) => void
  onReload: () => void
  onSaveTask: () => void
  onDeleteTask: (taskId: string) => void
  onSaveNote: () => void
  onDeleteNote: (noteId: string) => void
}

function displayOrganization(company: string, roleTitle: string): string {
  return [company, roleTitle].filter(Boolean).join(' · ')
}

function maskedPhone(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, '')
  const local =
    digits.startsWith('82') && digits.length === 12
      ? `0${digits.slice(2)}`
      : digits
  if (local.length < 8) return phoneE164
  return `${local.slice(0, 3)}-****-${local.slice(-4)}`
}

function noteTime(createdAt: number, updatedAt: number): string {
  const modified = updatedAt > createdAt ? ' · 수정됨' : ''
  return `${formatCalendarDate(updatedAt)} ${formatClockTime(updatedAt)}${modified}`
}

function ErrorBanner({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-open-border bg-open-bg px-3 py-2.5 text-[12.5px] text-open-fg"
    >
      <div className="flex items-start gap-2">
        <span className="flex-1">{message}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="오류 닫기"
          className="font-bold"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

function TaskForm({
  data,
  editingId,
  dispatchData,
  onDelete,
  onSave,
}: {
  data: CustomerCardDataState
  editingId: string | null
  dispatchData: InfoTabViewProps['dispatchData']
  onDelete: (taskId: string) => void
  onSave: () => void
}) {
  const draft = data.taskDraft

  return (
    <div className="border border-brand rounded-[9px] px-[11px] py-2.5 bg-brand-50">
      <input
        value={draft.name}
        onChange={(event) =>
          dispatchData({
            type: 'setTaskDraft',
            patch: { name: event.target.value },
          })
        }
        placeholder="업무 이름"
        className={`w-full text-[13.5px] text-ink ${inputClass} font-semibold mb-1.5`}
      />
      <input
        value={draft.sub}
        onChange={(event) =>
          dispatchData({
            type: 'setTaskDraft',
            patch: { sub: event.target.value },
          })
        }
        placeholder="기한 · 메모"
        className={`w-full text-[12.5px] text-ink-700 ${inputClass}`}
      />
      <div className="mt-2 flex gap-[5px]">
        {TASK_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() =>
              dispatchData({
                type: 'setTaskDraft',
                patch: { kind },
              })
            }
            className={`px-[11px] py-1 rounded-[14px] text-xs font-semibold border ${
              draft.kind === kind
                ? 'border-brand text-brand-text bg-brand-100'
                : 'border-line-strong text-ink-500 bg-white'
            }`}
          >
            {TASK_KIND_VIEW[kind].optionLabel}
          </button>
        ))}
      </div>
      <div className="mt-[9px] flex gap-1.5">
        <button
          type="button"
          onClick={onSave}
          className="h-7 px-3 rounded-lg bg-brand text-white flex items-center text-[12.5px] font-semibold"
        >
          저장
        </button>
        <button
          type="button"
          onClick={() => dispatchData({ type: 'cancelTask' })}
          className="h-7 px-2.5 border border-line-strong rounded-lg bg-white flex items-center text-[12.5px] text-ink-600"
        >
          취소
        </button>
        {editingId && (
          <button
            type="button"
            disabled={data.pendingTaskDeletes.includes(editingId)}
            onClick={() => onDelete(editingId)}
            className="ml-auto h-7 px-2.5 flex items-center text-[12.5px] text-open-fg disabled:opacity-50"
          >
            삭제
          </button>
        )}
      </div>
    </div>
  )
}

function NoteForm({
  data,
  editingId,
  dispatchData,
  onDelete,
  onSave,
}: {
  data: CustomerCardDataState
  editingId: string | null
  dispatchData: InfoTabViewProps['dispatchData']
  onDelete: (noteId: string) => void
  onSave: () => void
}) {
  return (
    <div className={editingId ? 'mt-[5px]' : 'mt-[11px]'}>
      <input
        value={data.noteDraft}
        onChange={(event) =>
          dispatchData({
            type: 'setNoteDraft',
            value: event.target.value,
          })
        }
        placeholder="메모를 입력하세요"
        className="w-full text-[13.5px] text-ink border border-brand rounded-lg px-2.5 py-2 outline-none"
      />
      <div className="mt-[7px] flex gap-1.5">
        <button
          type="button"
          onClick={onSave}
          className="h-7 px-3 rounded-lg bg-brand text-white flex items-center text-[12.5px] font-semibold"
        >
          저장
        </button>
        <button
          type="button"
          onClick={() => dispatchData({ type: 'cancelNote' })}
          className="h-7 px-2.5 border border-line-strong rounded-lg flex items-center text-[12.5px] text-ink-600"
        >
          취소
        </button>
        {editingId && (
          <button
            type="button"
            disabled={data.pendingNoteDeletes.includes(editingId)}
            onClick={() => onDelete(editingId)}
            className="ml-auto h-7 px-2.5 rounded-lg flex items-center text-[12.5px] text-open-fg disabled:opacity-50"
          >
            삭제
          </button>
        )}
      </div>
    </div>
  )
}

export function InfoTabView({
  conversationId,
  data,
  sessionUserId,
  dispatchData,
  onReload,
  onSaveTask,
  onDeleteTask,
  onSaveNote,
  onDeleteNote,
}: InfoTabViewProps) {
  const entry = data.cardEntries[conversationId]
  const detail = entry?.detail

  if (
    !detail &&
    (!entry || entry.status === 'idle' || entry.status === 'loading')
  ) {
    return (
      <Card className="px-[15px] py-12 text-center text-[13px] text-ink-400">
        고객 카드를 불러오고 있습니다.
      </Card>
    )
  }

  if (!detail) {
    return (
      <Card className="px-[15px] py-10 text-center">
        <div role="alert" className="text-[13px] text-open-fg">
          {entry.error ?? '고객 카드를 불러오지 못했습니다.'}
        </div>
        <button
          type="button"
          onClick={onReload}
          className="mt-3 h-8 px-3 rounded-lg bg-brand text-white text-[12.5px] font-semibold"
        >
          다시 시도
        </button>
      </Card>
    )
  }

  const customer = detail.customer
  const edit =
    data.editDraft?.conversationId === conversationId ? data.editDraft : null
  const conflict =
    data.customerConflict?.conversationId === conversationId
      ? data.customerConflict
      : null
  const mutationError =
    data.cardMutationError?.conversationId === conversationId
      ? data.cardMutationError
      : null
  const taskEditorActive = data.taskEditorConversationId === conversationId
  const taskEditId =
    taskEditorActive &&
    data.taskEditId !== null &&
    detail.tasks.some(({ id }) => id === data.taskEditId)
      ? data.taskEditId
      : null
  const addingTask = taskEditorActive && data.addingTask
  const noteEditorActive = data.noteEditorConversationId === conversationId
  const noteEditId =
    noteEditorActive &&
    data.noteEditId !== null &&
    detail.notes.some(({ id }) => id === data.noteEditId)
      ? data.noteEditId
      : null
  const addingNote = noteEditorActive && data.addingNote
  const fields = edit?.fields ?? customer.fields

  return (
    <>
      {entry.status === 'loading' && (
        <div className="text-center text-[11.5px] text-ink-400">
          최신 고객 정보를 확인하고 있습니다.
        </div>
      )}

      {entry.error && <ErrorBanner message={entry.error} onClose={onReload} />}

      {mutationError && (
        <ErrorBanner
          message={mutationError.message}
          onClose={() => dispatchData({ type: 'clearCardMutationError' })}
        />
      )}

      {conflict && edit && (
        <div
          role="alert"
          className="rounded-lg border border-warn-border bg-warn-bg px-3 py-3 text-[12.5px] text-ink-700"
        >
          <div className="font-bold text-doing-fg">
            다른 직원이 먼저 고객 정보를 수정했습니다.
          </div>
          <div className="mt-1 leading-relaxed">
            서버의 최신 값과 내 변경을 비교한 뒤 선택해 주세요. 어느 쪽도
            자동으로 덮어쓰지 않습니다.
          </div>
          <div className="mt-2.5 flex gap-1.5">
            <button
              type="button"
              onClick={() =>
                dispatchData({ type: 'useServerCustomer', conversationId })
              }
              className="h-7 px-2.5 rounded-lg border border-line-strong bg-white font-semibold"
            >
              서버 값 사용
            </button>
            <button
              type="button"
              onClick={() =>
                dispatchData({ type: 'rebaseCustomerEdit', conversationId })
              }
              className="h-7 px-2.5 rounded-lg bg-brand text-white font-semibold"
            >
              내 변경 이어서 편집
            </button>
          </div>
        </div>
      )}

      <Card className="px-[15px] pt-4 pb-3.5">
        <div className="flex items-center gap-3 pb-3.5 border-b border-fill mb-[13px]">
          <Avatar
            initial={customer.name[0] ?? '?'}
            className="w-[46px] h-[46px] text-lg"
          />
          <div className="min-w-0 flex-1">
            {edit ? (
              <>
                <input
                  value={edit.name}
                  onChange={(event) =>
                    dispatchData({
                      type: 'setEditName',
                      value: event.target.value,
                    })
                  }
                  placeholder="고객명"
                  className={`w-full text-sm text-ink ${inputClass} font-semibold mb-[5px]`}
                />
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    value={edit.company}
                    onChange={(event) =>
                      dispatchData({
                        type: 'setEditCompany',
                        value: event.target.value,
                      })
                    }
                    placeholder="상호"
                    aria-label="상호"
                    className={`w-full text-[12.5px] text-ink-700 ${inputClass}`}
                  />
                  <input
                    value={edit.roleTitle}
                    onChange={(event) =>
                      dispatchData({
                        type: 'setEditRoleTitle',
                        value: event.target.value,
                      })
                    }
                    placeholder="직함"
                    aria-label="직함"
                    className={`w-full text-[12.5px] text-ink-700 ${inputClass}`}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="text-base font-bold tracking-[-0.3px]">
                  {customer.name}
                </div>
                <div className="text-[12.5px] text-ink-500 truncate">
                  {displayOrganization(customer.company, customer.roleTitle)}
                </div>
                <div className="mt-0.5 text-[11.5px] text-ink-400">
                  {maskedPhone(customer.phoneE164)}
                </div>
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
          {fields.map((field) => (
            <div key={field.id} className="flex items-center gap-2">
              {edit ? (
                <>
                  <input
                    value={field.key}
                    onChange={(event) =>
                      dispatchData({
                        type: 'setEditField',
                        fieldId: field.id,
                        patch: { key: event.target.value },
                      })
                    }
                    aria-label="세무 정보 항목"
                    className={`w-[92px] flex-none text-[12.5px] text-ink-500 ${inputClass}`}
                  />
                  <input
                    value={field.value}
                    onChange={(event) =>
                      dispatchData({
                        type: 'setEditField',
                        fieldId: field.id,
                        patch: { value: event.target.value },
                      })
                    }
                    aria-label={`${field.key || '새 항목'} 값`}
                    className={`flex-1 min-w-0 text-[13.5px] text-ink ${inputClass} font-medium`}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      dispatchData({
                        type: 'removeEditField',
                        fieldId: field.id,
                      })
                    }
                    aria-label={`${field.key || '새 항목'} 삭제`}
                    className="flex-none text-[11.5px] text-open-fg"
                  >
                    삭제
                  </button>
                </>
              ) : (
                <>
                  <span className="w-[78px] flex-none text-[12.5px] text-ink-500">
                    {field.key}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      dispatchData({
                        type: 'startEdit',
                        conversationId,
                      })
                    }
                    className="flex-1 text-left text-[13.5px] font-medium border-b border-dashed border-line-soft pb-0.5 cursor-text hover:border-brand hover:text-brand"
                  >
                    {field.value}
                  </button>
                </>
              )}
            </div>
          ))}
          {edit && (
            <button
              type="button"
              onClick={() =>
                dispatchData({
                  type: 'addEditField',
                  fieldId: `local-${crypto.randomUUID()}`,
                })
              }
              className="self-start text-[12.5px] text-brand font-semibold"
            >
              ＋ 항목 추가
            </button>
          )}
        </div>
      </Card>

      <Card className="px-[15px] py-3.5">
        <div className="flex items-center mb-2.5">
          <span className="text-[13px] font-bold">진행 중인 업무</span>
          {!addingTask && taskEditId === null && (
            <button
              type="button"
              onClick={() => dispatchData({ type: 'addTask', conversationId })}
              className="ml-auto text-[12.5px] text-brand font-semibold"
            >
              ＋ 추가
            </button>
          )}
        </div>
        <div className="flex flex-col gap-[7px]">
          {detail.tasks.map((task) =>
            taskEditId === task.id ? (
              <TaskForm
                key={task.id}
                data={data}
                editingId={taskEditId}
                dispatchData={dispatchData}
                onDelete={onDeleteTask}
                onSave={onSaveTask}
              />
            ) : (
              <div
                key={task.id}
                className={`rounded-[9px] px-[11px] py-2.5 border ${TASK_KIND_VIEW[task.kind].cardClass}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[13.5px] font-semibold">
                    {task.name}
                  </span>
                  <span
                    className={`ml-auto text-[11px] rounded px-1.5 py-px ${TASK_KIND_VIEW[task.kind].badgeClass}`}
                  >
                    {TASK_KIND_VIEW[task.kind].badge}
                  </span>
                  <button
                    type="button"
                    disabled={data.pendingTaskDeletes.includes(task.id)}
                    onClick={() =>
                      dispatchData({
                        type: 'editTask',
                        conversationId,
                        taskId: task.id,
                      })
                    }
                    className="ml-2 text-[11.5px] text-brand font-semibold disabled:opacity-50"
                  >
                    {data.pendingTaskDeletes.includes(task.id)
                      ? '삭제 중'
                      : '수정'}
                  </button>
                </div>
                <div className="text-[12.5px] text-ink-500 mt-[3px]">
                  {task.sub}
                </div>
              </div>
            ),
          )}
          {addingTask && (
            <TaskForm
              data={data}
              editingId={null}
              dispatchData={dispatchData}
              onDelete={onDeleteTask}
              onSave={onSaveTask}
            />
          )}
        </div>
      </Card>

      <Card className="px-[15px] py-3.5">
        <div className="flex items-center mb-[11px]">
          <span className="text-[13px] font-bold">고객 메모</span>
          <span className="ml-auto text-[11.5px] text-ink-400">
            직원에게만 보임
          </span>
        </div>
        <div className="flex flex-col gap-[11px]">
          {detail.notes.map((note) => (
            <div key={note.id} className="flex gap-[9px]">
              <Avatar
                initial={note.authorName[0] ?? '?'}
                className="w-[26px] h-[26px] text-[11px]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] font-semibold">
                    {note.authorName}
                  </span>
                  <span className="text-[11.5px] text-ink-400">
                    {noteTime(note.createdAt, note.updatedAt)}
                  </span>
                  {noteEditId !== note.id &&
                    note.authorId === sessionUserId && (
                      <button
                        type="button"
                        disabled={data.pendingNoteDeletes.includes(note.id)}
                        onClick={() =>
                          dispatchData({
                            type: 'editNote',
                            conversationId,
                            noteId: note.id,
                          })
                        }
                        className="ml-auto text-[11.5px] text-brand font-semibold disabled:opacity-50"
                      >
                        {data.pendingNoteDeletes.includes(note.id)
                          ? '삭제 중'
                          : '수정'}
                      </button>
                    )}
                </div>
                {noteEditId === note.id ? (
                  <NoteForm
                    data={data}
                    editingId={noteEditId}
                    dispatchData={dispatchData}
                    onDelete={onDeleteNote}
                    onSave={onSaveNote}
                  />
                ) : (
                  <div className="mt-[3px] text-[13.5px] text-ink-700 leading-[1.55]">
                    {note.body}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        {addingNote ? (
          <NoteForm
            data={data}
            editingId={null}
            dispatchData={dispatchData}
            onDelete={onDeleteNote}
            onSave={onSaveNote}
          />
        ) : (
          <button
            type="button"
            onClick={() => dispatchData({ type: 'addNote', conversationId })}
            className="mt-[11px] w-full h-8 border border-dashed border-line-soft rounded-lg flex items-center justify-center text-[12.5px] text-ink-500 hover:border-brand hover:text-brand"
          >
            ＋ 메모 추가
          </button>
        )}
      </Card>
    </>
  )
}
