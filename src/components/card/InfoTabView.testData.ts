import type { ConversationDetail } from '../../../shared/wire/conversation'
import {
  initialCustomerCardDataState,
  reduceCustomerCardData,
  type CustomerCardDataState,
} from '../../state/customerCardModel'

export const INFO_TAB_DETAIL: ConversationDetail = {
  id: 'conversation-1',
  officeChannel: {
    id: 'office-channel-1',
    label: '업무폰 1',
    value: '01012345678',
  },
  status: '미처리',
  label: '',
  archived: false,
  version: 1,
  customer: {
    id: 'customer-1',
    name: '홍길동',
    company: '리치 · 세무',
    roleTitle: '대표',
    phoneE164: '+821012345678',
    version: 1,
    fields: [
      { id: 'field-1', key: '사업자 유형', value: '법인', sortOrder: 0 },
    ],
  },
  assignees: [],
  tasks: [
    {
      id: 'task-1',
      name: '부가세 신고',
      sub: '기한 8/10',
      kind: 'done',
      sortOrder: 0,
      createdById: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  notes: [
    {
      id: 'note-own',
      authorId: 'user-1',
      authorName: '바뀐 이름',
      body: '내 메모',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'note-other',
      authorId: 'user-2',
      authorName: '바뀐 이름',
      body: '타인 메모',
      createdAt: 2,
      updatedAt: 2,
    },
  ],
}

export function loadedInfoTabState(): CustomerCardDataState {
  return reduceCustomerCardData(initialCustomerCardDataState, {
    type: 'cardLoadSucceeded',
    detail: INFO_TAB_DETAIL,
  })
}
