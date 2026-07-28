import type { CustomerCardController } from '../../hooks/useCustomerCard'
import { Card } from '../ui'
import { InfoTabView } from './InfoTabView'

export function InfoTab({
  controller,
}: {
  controller: CustomerCardController
}) {
  if (!controller.conversationId) {
    return (
      <Card className="px-[15px] py-12 text-center text-[13px] text-ink-400">
        대화를 선택하면 고객 정보를 볼 수 있습니다.
      </Card>
    )
  }

  return (
    <InfoTabView
      conversationId={controller.conversationId}
      data={controller.data}
      sessionUserId={controller.sessionUserId}
      dispatchData={controller.dispatchData}
      onReload={controller.reload}
      onSaveTask={controller.saveTask}
      onDeleteTask={controller.deleteTask}
      onSaveNote={controller.saveNote}
      onDeleteNote={controller.deleteNote}
    />
  )
}
