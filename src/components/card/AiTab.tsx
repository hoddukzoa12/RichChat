import { Card } from '../ui'

export function AiTab() {
  return (
    <Card className="px-[15px] py-8 text-center">
      <span className="mx-auto w-9 h-9 rounded-[10px] bg-brand text-white text-xs font-bold flex items-center justify-center">
        AI
      </span>
      <div className="mt-3 text-[14px] font-bold text-ink">AI 기능 준비 중</div>
      <p className="mt-1.5 text-[12.5px] leading-5 text-ink-500">
        대화 요약과 질문 기능을 준비하고 있습니다.
        <br />
        기능이 연결되면 이 탭에서 사용할 수 있습니다.
      </p>
    </Card>
  )
}
