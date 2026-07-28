import { Card } from '../ui'

export function FolderTab() {
  return (
    <Card className="px-[15px] py-8 text-center">
      <div className="flex justify-center">
        <span className="text-[10.5px] font-semibold text-works-fg bg-works-bg rounded px-1.5 py-[1.5px]">
          네이버웍스 드라이브
        </span>
      </div>
      <div className="mx-auto mt-3 w-[34px] h-[27px] rounded-[4px_7px_7px_7px] bg-folder shadow-[inset_0_4px_0_#FDB022]" />
      <div className="mt-3 text-[14px] font-bold text-ink">폴더 연동 준비 중</div>
      <p className="mt-1.5 text-[12.5px] leading-5 text-ink-500">
        고객 문서를 연결하는 기능을 준비하고 있습니다.
        <br />
        연동이 완료되면 이 탭에서 사용할 수 있습니다.
      </p>
    </Card>
  )
}
