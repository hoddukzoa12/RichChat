import { useInbox } from '../../state/InboxContext'
import { Card } from '../ui'

export function FolderTab() {
  const { dispatch, cur } = useInbox()

  return (
    <Card className="px-[15px] py-3.5">
      <div className="flex items-center gap-[7px] mb-[11px]">
        <span className="text-[13px] font-bold text-ink">연결된 폴더</span>
        <span className="text-[10.5px] font-semibold text-works-fg bg-works-bg rounded px-1.5 py-[1.5px]">
          네이버웍스 드라이브
        </span>
        {cur.folderLinked && (
          <span className="ml-auto flex gap-2.5 text-xs font-semibold">
            <button
              type="button"
              onClick={() => dispatch({ type: 'unlinkFolder' })}
              className="text-ink-500"
            >
              변경
            </button>
            <button type="button" className="text-brand">
              열기
            </button>
          </span>
        )}
      </div>

      {cur.folderLinked ? (
        <>
          <div className="flex items-center gap-[9px] px-[11px] py-2.5 border border-line rounded-[9px] bg-surface">
            <div className="w-6 h-[19px] flex-none rounded-[3px_5px_5px_5px] bg-folder shadow-[inset_0_3px_0_#FDB022]" />
            <span className="text-[13.5px] font-semibold truncate">{cur.folderPath}</span>
            <span className="ml-auto text-xs text-ink-400 flex-none">문서 {cur.docCount}</span>
          </div>

          <div className="mt-3 flex items-center gap-[7px]">
            <span className="text-[12.5px] text-ink-500 font-semibold">최근 문서</span>
            <button type="button" className="ml-auto text-xs text-brand font-semibold">
              전체 보기
            </button>
          </div>

          <div className="mt-2 flex flex-col gap-[7px]">
            {cur.docs.map((d) => (
              <button
                key={d.name}
                type="button"
                className="flex items-center gap-[9px] px-2.5 py-[9px] border border-line rounded-[9px] text-left hover:border-brand hover:bg-brand-50"
              >
                <span className="w-[17px] h-[21px] flex-none border border-line-strong rounded-sm bg-white" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium truncate">{d.name}</span>
                  <span className="block text-[11.5px] text-ink-400">{d.meta}</span>
                </span>
              </button>
            ))}
            {cur.docs.length === 0 && (
              <div className="py-6 text-center text-[12.5px] text-ink-400">문서가 없습니다</div>
            )}
          </div>

          <div className="mt-3 pt-3 border-t border-fill flex items-center gap-2">
            <span className="text-[10.5px] font-bold text-white bg-brand rounded px-1.5 py-[1.5px] flex-none">
              AI
            </span>
            <span className="text-xs text-ink-500 leading-snug">문서 {cur.docCount}건 분석 완료</span>
            <button type="button" className="ml-auto text-xs text-brand font-semibold flex-none">
              다시 분석
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => dispatch({ type: 'linkFolder' })}
          className="w-full border border-dashed border-brand-300 rounded-[10px] px-3.5 py-5 bg-brand-50 flex flex-col items-center gap-2.5"
        >
          <div className="w-[34px] h-[27px] rounded-[4px_7px_7px_7px] bg-folder shadow-[inset_0_4px_0_#FDB022]" />
          <div className="text-[13px] text-ink-600 text-center leading-[1.55]">
            이 고객의 문서 폴더를 지정하면
            <br />
            AI가 문서를 읽어 세무 정보를 채웁니다
          </div>
          <span className="h-[34px] px-4 rounded-lg bg-brand text-white flex items-center text-[13px] font-semibold">
            폴더 지정하기
          </span>
        </button>
      )}
    </Card>
  )
}
