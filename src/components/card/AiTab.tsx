import { useInbox } from '../../state/InboxContext'
import { AI_SUGGESTIONS } from '../../state/selectors'

function AiMark() {
  return (
    <span className="w-6 h-6 flex-none rounded-[7px] bg-brand text-white text-[10px] font-bold flex items-center justify-center">
      AI
    </span>
  )
}

export function AiTab() {
  const { state, dispatch, cur, askAi } = useInbox()
  const chat = state.aiChats[cur.id] ?? []

  return (
    <>
      <div className="bg-linear-to-b from-brand-50 to-white border border-brand-300 rounded-xl px-[15px] py-3.5 shadow-[0_1px_2px_rgba(16,24,40,.04)]">
        <div className="flex items-center gap-[7px] mb-[9px]">
          <span className="text-[11px] font-bold text-white bg-brand rounded-[5px] px-[7px] py-0.5 tracking-[0.2px]">
            대화 요약
          </span>
          <span className="text-[11.5px] text-ink-400">방금 갱신</span>
          <button type="button" className="ml-auto text-xs text-brand font-semibold">
            다시 요약
          </button>
        </div>

        <div className="text-[13.5px] text-ink-700 leading-[1.62]">{cur.summary}</div>

        <div className="mt-[11px] flex flex-col gap-1.5">
          {cur.todos.map((t, i) => (
            <button
              key={i}
              type="button"
              onClick={() => dispatch({ type: 'toggleTodo', index: i })}
              className={`flex items-center gap-2 text-[13px] text-left ${
                t.done ? 'text-ink-400 line-through' : 'text-ink-700'
              }`}
            >
              <span
                className={`w-[15px] h-[15px] rounded flex-none ${
                  t.done
                    ? 'bg-brand text-white text-[10px] flex items-center justify-center'
                    : 'border-[1.5px] border-ink-300'
                }`}
              >
                {t.done ? '✓' : ''}
              </span>
              {t.text}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => dispatch({ type: 'draftReply' })}
          className="mt-[11px] w-full h-8 rounded-lg bg-brand text-white flex items-center justify-center text-[13px] font-semibold hover:bg-brand-hover"
        >
          답장 초안 만들어 입력창에 넣기
        </button>
      </div>

      {chat.length === 0 && !state.aiLoading && (
        <div className="flex flex-col gap-1.5">
          {AI_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => askAi(s)}
              className="text-left text-[12.5px] text-ink-600 border border-line rounded-lg px-2.5 py-2 bg-white hover:border-brand hover:text-brand"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {chat.map((m, i) =>
        m.role === 'ai' ? (
          <div key={i} className="flex gap-2 items-start">
            <AiMark />
            <div className="bg-white border border-line rounded-[4px_12px_12px_12px] px-[13px] py-[11px] text-[13.5px] text-ink-700 leading-[1.6]">
              {m.text}
            </div>
          </div>
        ) : (
          <div
            key={i}
            className="self-end max-w-[86%] bg-brand text-white rounded-[12px_4px_12px_12px] px-[13px] py-2.5 text-[13.5px]"
          >
            {m.text}
          </div>
        ),
      )}

      {state.aiLoading && (
        <div className="flex gap-2 items-start">
          <AiMark />
          <div className="bg-white border border-line rounded-[4px_12px_12px_12px] p-[13px] flex items-center gap-[5px]">
            <span className="w-1.5 h-1.5 rounded-full bg-brand animate-dot-pulse" />
            <span className="w-1.5 h-1.5 rounded-full bg-brand animate-dot-pulse [animation-delay:.18s]" />
            <span className="w-1.5 h-1.5 rounded-full bg-brand animate-dot-pulse [animation-delay:.36s]" />
            <span className="ml-[5px] text-xs text-ink-400">대화와 문서를 확인하는 중</span>
          </div>
        </div>
      )}
    </>
  )
}

export function AiComposer() {
  const { state, dispatch, askAi } = useInbox()
  const canSend = state.aiDraft.trim().length > 0

  return (
    <div className="flex-none border-t border-line bg-white px-3.5 py-3">
      <div className="flex items-center gap-2 border-[1.5px] border-line-strong rounded-[11px] pl-3 pr-1 py-1 focus-within:border-brand">
        <input
          value={state.aiDraft}
          onChange={(e) => dispatch({ type: 'setAiDraft', value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              askAi(state.aiDraft)
            }
          }}
          placeholder="이 고객에 대해 물어보세요"
          className="flex-1 min-w-0 border-none outline-none bg-transparent text-[13.5px] py-[7px] text-ink"
        />
        <button
          type="button"
          disabled={!canSend}
          onClick={() => askAi(state.aiDraft)}
          className={`w-8 h-8 flex-none rounded-lg flex items-center justify-center text-[15px] text-white ${
            canSend ? 'bg-brand cursor-pointer' : 'bg-line-soft cursor-default'
          }`}
        >
          ↑
        </button>
      </div>
    </div>
  )
}
