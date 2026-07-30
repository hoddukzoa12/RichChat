import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationDetail } from '../../../shared/wire/conversation'
import {
  initialCustomerCardDataState,
  reduceCustomerCardData,
  type CustomerCardDataState,
} from '../../state/customerCardModel'
import { InfoTabView } from './InfoTabView'

const DETAIL: ConversationDetail = {
  id: 'conversation-1',
  officeChannel: {
    id: 'office-channel-1',
    label: '업무폰 1',
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

function loadedState(): CustomerCardDataState {
  return reduceCustomerCardData(initialCustomerCardDataState, {
    type: 'cardLoadSucceeded',
    detail: DETAIL,
  })
}

function render(
  data: CustomerCardDataState,
  conversationId = DETAIL.id,
): string {
  return renderToStaticMarkup(
    <InfoTabView
      conversationId={conversationId}
      data={data}
      sessionUserId="user-1"
      dispatchData={vi.fn()}
      onReload={vi.fn()}
      onSaveTask={vi.fn()}
      onDeleteTask={vi.fn()}
      onSaveNote={vi.fn()}
      onDeleteNote={vi.fn()}
    />,
  )
}

describe('Info tab view', () => {
  it('renders organization and role without parsing company punctuation', () => {
    const markup = render(loadedState())

    expect(markup).toContain('리치 · 세무 · 대표')
    expect(markup).toContain('010-****-5678')
    expect(markup).not.toContain('+821012345678')
  })

  it('renders separate company and role inputs without a phone input', () => {
    const data = reduceCustomerCardData(loadedState(), {
      type: 'startEdit',
      conversationId: DETAIL.id,
    })
    const markup = render(data)

    expect(markup).toContain('aria-label="상호"')
    expect(markup).toContain('aria-label="직함"')
    expect(markup).not.toContain('aria-label="전화번호"')
  })

  it('derives the done badge from kind and authorizes note editing by user id', () => {
    const markup = render(loadedState())

    expect(markup).toContain('부가세 신고')
    expect(markup).toContain('>완료<')
    expect(markup.match(/>수정</g)).toHaveLength(2)
  })

  it('shows version conflicts and forbidden mutation errors', () => {
    let data = reduceCustomerCardData(loadedState(), {
      type: 'startEdit',
      conversationId: DETAIL.id,
    })
    data = reduceCustomerCardData(data, {
      type: 'customerConflict',
      conversationId: DETAIL.id,
      current: {
        ...DETAIL.customer,
        updatedAt: 2,
        version: 2,
        fields: DETAIL.customer.fields.map((field) => ({
          ...field,
          updatedAt: 2,
        })),
      },
    })
    data = {
      ...data,
      cardMutationError: {
        conversationId: DETAIL.id,
        scope: 'note',
        status: 403,
        message: '메모를 변경할 수 없습니다.',
      },
    }

    const markup = render(data)
    expect(markup).toContain('다른 직원이 먼저 고객 정보를 수정했습니다.')
    expect(markup).toContain('서버 값 사용')
    expect(markup).toContain('내 변경 이어서 편집')
    expect(markup).toContain('메모를 변경할 수 없습니다.')
  })

  it('does not render editors owned by another conversation', () => {
    const other = {
      ...DETAIL,
      id: 'conversation-2',
      customer: { ...DETAIL.customer, id: 'customer-2' },
      tasks: [],
      notes: [],
    }
    let data = reduceCustomerCardData(loadedState(), {
      type: 'addTask',
      conversationId: DETAIL.id,
    })
    data = reduceCustomerCardData(data, {
      type: 'addNote',
      conversationId: DETAIL.id,
    })
    data = reduceCustomerCardData(data, {
      type: 'cardLoadSucceeded',
      detail: other,
    })

    const markup = render(data, other.id)
    expect(markup).not.toContain('placeholder="업무 이름"')
    expect(markup).not.toContain('placeholder="메모를 입력하세요"')
  })
})
