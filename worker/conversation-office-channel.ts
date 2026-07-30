import type {
  ConversationOfficeChannel,
} from '../shared/wire/conversation'

export interface ConversationOfficeChannelRow {
  office_channel_id: string | null
  office_channel_label: string | null
  office_channel_value: string | null
}

export function conversationOfficeChannelFromRow(
  row: ConversationOfficeChannelRow,
): ConversationOfficeChannel | null {
  if (row.office_channel_id === null) return null
  if (
    row.office_channel_label === null ||
    row.office_channel_value === null
  ) {
    throw new Error('업무폰 읽기 모델이 완전하지 않습니다.')
  }

  return {
    id: row.office_channel_id,
    label: row.office_channel_label,
    value: row.office_channel_value,
  }
}
