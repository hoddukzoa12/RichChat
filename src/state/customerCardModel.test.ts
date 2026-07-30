import { describe, expect, it } from 'vitest'
import type { ConversationDetail } from '../../shared/wire/conversation'
import type { CustomerCard } from '../../shared/wire/card'
import {
  customerUpdateRequest,
  initialCustomerCardDataState,
  reduceCustomerCardData,
  type CustomerCardDataAction,
  type CustomerCardDataState,
} from './customerCardModel'

const DETAIL: ConversationDetail = {
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
      { id: 'field-1', key: '사업자 유형', value: '개인', sortOrder: 0 },
      { id: 'field-2', key: '과세 유형', value: '일반', sortOrder: 1 },
      { id: 'field-3', key: '업종', value: '도소매', sortOrder: 2 },
    ],
  },
  assignees: [],
  tasks: [
    {
      id: 'task-1',
      name: '원천세 신고',
      sub: '',
      kind: 'warn',
      sortOrder: 0,
      createdById: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'task-2',
      name: '부가세 신고',
      sub: '',
      kind: 'done',
      sortOrder: 1,
      createdById: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'task-3',
      name: '종소세 신고',
      sub: '',
      kind: 'idle',
      sortOrder: 2,
      createdById: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  notes: [
    {
      id: 'note-1',
      authorId: 'user-1',
      authorName: '박상담',
      body: '첫 메모',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'note-2',
      authorId: 'user-2',
      authorName: '김상담',
      body: '가운데 메모',
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: 'note-3',
      authorId: 'user-1',
      authorName: '박상담',
      body: '마지막 메모',
      createdAt: 3,
      updatedAt: 3,
    },
  ],
}

function run(actions: CustomerCardDataAction[]): CustomerCardDataState {
  return actions.reduce(reduceCustomerCardData, initialCustomerCardDataState)
}

describe('Customer card model', () => {
  it('keeps details keyed by conversation and scopes editors to their owner', () => {
    const other = {
      ...DETAIL,
      id: 'conversation-2',
      customer: { ...DETAIL.customer, id: 'customer-2' },
    }
    const state = run([
      { type: 'cardLoadSucceeded', detail: DETAIL },
      { type: 'cardLoadSucceeded', detail: other },
      { type: 'startEdit', conversationId: DETAIL.id },
      { type: 'addTask', conversationId: DETAIL.id },
      { type: 'addNote', conversationId: DETAIL.id },
    ])

    expect(state.cardEntries[DETAIL.id].detail).toBe(DETAIL)
    expect(state.cardEntries[other.id].detail).toBe(other)
    expect(state).toMatchObject({
      editDraft: { conversationId: DETAIL.id },
      taskEditorConversationId: DETAIL.id,
      taskEditId: null,
      addingTask: true,
      noteEditorConversationId: DETAIL.id,
      noteEditId: null,
      addingNote: true,
    })
  })

  it('updates and deletes nested rows by id after a middle row disappears', () => {
    const state = run([
      { type: 'cardLoadSucceeded', detail: DETAIL },
      { type: 'taskDeleteStarted', taskId: 'task-2' },
      {
        type: 'taskDeleteSucceeded',
        conversationId: DETAIL.id,
        taskId: 'task-2',
      },
      {
        type: 'taskUpdateOptimistic',
        conversationId: DETAIL.id,
        taskId: 'task-3',
        patch: { name: '종소세 완료', sub: '', kind: 'done' },
      },
      { type: 'noteDeleteStarted', noteId: 'note-2' },
      {
        type: 'noteDeleteSucceeded',
        conversationId: DETAIL.id,
        noteId: 'note-2',
      },
      {
        type: 'noteUpdateOptimistic',
        conversationId: DETAIL.id,
        noteId: 'note-3',
        body: '수정한 마지막 메모',
        updatedAt: 4,
      },
    ])

    const detail = state.cardEntries[DETAIL.id].detail
    expect(detail?.tasks.map(({ id }) => id)).toEqual(['task-1', 'task-3'])
    expect(detail?.tasks[1]).toMatchObject({
      id: 'task-3',
      name: '종소세 완료',
      kind: 'done',
    })
    expect(detail?.notes.map(({ id }) => id)).toEqual(['note-1', 'note-3'])
    expect(detail?.notes[1]).toMatchObject({
      id: 'note-3',
      body: '수정한 마지막 메모',
    })
  })

  it('keeps a done task done through server replacement and another edit', () => {
    const loaded = run([{ type: 'cardLoadSucceeded', detail: DETAIL }])
    const edited = reduceCustomerCardData(loaded, {
      type: 'taskUpdateOptimistic',
      conversationId: DETAIL.id,
      taskId: 'task-2',
      patch: { name: '부가세 신고', sub: '완료 확인', kind: 'done' },
    })
    const saved = reduceCustomerCardData(edited, {
      type: 'taskUpdateSucceeded',
      conversationId: DETAIL.id,
      task: {
        ...DETAIL.tasks[1],
        sub: '완료 확인',
        kind: 'done',
        updatedAt: 2,
      },
    })

    expect(saved.cardEntries[DETAIL.id].detail?.tasks[1].kind).toBe('done')
  })

  it('reconciles optimistic rows with an earlier server event by id', () => {
    const serverTask = {
      ...DETAIL.tasks[0],
      id: 'task-server',
      name: '새 업무',
    }
    const optimistic = {
      ...serverTask,
      id: 'optimistic-task-1',
      optimistic: true as const,
    }
    const state = run([
      { type: 'cardLoadSucceeded', detail: DETAIL },
      {
        type: 'taskCreateOptimistic',
        conversationId: DETAIL.id,
        task: optimistic,
      },
      {
        type: 'taskUpdateSucceeded',
        conversationId: DETAIL.id,
        task: serverTask,
      },
      {
        type: 'taskCreateSucceeded',
        conversationId: DETAIL.id,
        optimisticId: optimistic.id,
        task: serverTask,
      },
    ])

    expect(
      state.cardEntries[DETAIL.id].detail?.tasks.filter(
        ({ id }) => id === serverTask.id,
      ),
    ).toHaveLength(1)
    expect(
      state.cardEntries[DETAIL.id].detail?.tasks.some(
        ({ id }) => id === optimistic.id,
      ),
    ).toBe(false)
  })

  it('builds customer field changes by stable id and never sends phone', () => {
    let state = run([
      { type: 'cardLoadSucceeded', detail: DETAIL },
      { type: 'startEdit', conversationId: DETAIL.id },
      { type: 'removeEditField', fieldId: 'field-2' },
      {
        type: 'setEditField',
        fieldId: 'field-3',
        patch: { value: '전자상거래' },
      },
      { type: 'setEditCompany', value: '리치 · 세무법인' },
      { type: 'setEditRoleTitle', value: '공동대표' },
    ])

    if (!state.editDraft) throw new Error('Expected an edit draft')
    const request = customerUpdateRequest(state.editDraft)
    expect(request).toEqual({
      version: 1,
      company: '리치 · 세무법인',
      roleTitle: '공동대표',
      fieldChanges: {
        create: [],
        update: [
          {
            id: 'field-3',
            key: '업종',
            value: '전자상거래',
            sortOrder: 1,
          },
        ],
        delete: ['field-2'],
      },
    })
    expect(JSON.stringify(request)).not.toContain('phone')

    state = reduceCustomerCardData(state, {
      type: 'addEditField',
      fieldId: 'local-field-1',
    })
    expect(state.editDraft?.fields.at(-1)?.id).toBe('local-field-1')
  })

  it('offers explicit server or rebased local resolution after a version conflict', () => {
    const current: CustomerCard = {
      id: 'customer-1',
      phoneE164: '+821012345678',
      name: '서버 이름',
      company: '서버 상호',
      roleTitle: '대표',
      version: 2,
      updatedAt: 2,
      fields: [
        {
          id: 'field-1',
          key: '사업자 유형',
          value: '법인',
          sortOrder: 0,
          updatedAt: 2,
        },
        {
          id: 'field-server',
          key: '서버 추가',
          value: '보존',
          sortOrder: 1,
          updatedAt: 2,
        },
      ],
    }
    const conflicted = run([
      { type: 'cardLoadSucceeded', detail: DETAIL },
      { type: 'startEdit', conversationId: DETAIL.id },
      { type: 'setEditName', value: '내 이름' },
      {
        type: 'setEditField',
        fieldId: 'field-3',
        patch: { value: '내 업종' },
      },
      { type: 'customerConflict', conversationId: DETAIL.id, current },
    ])
    const rebased = reduceCustomerCardData(conflicted, {
      type: 'rebaseCustomerEdit',
      conversationId: DETAIL.id,
    })

    expect(rebased.editDraft).toMatchObject({
      name: '내 이름',
      company: '서버 상호',
      version: 2,
    })
    expect(rebased.editDraft?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'field-server', value: '보존' }),
        expect.objectContaining({
          id: 'rebased-field-3',
          value: '내 업종',
          isNew: true,
        }),
      ]),
    )
    expect(rebased.customerConflict).toBeNull()

    const accepted = reduceCustomerCardData(conflicted, {
      type: 'useServerCustomer',
      conversationId: DETAIL.id,
    })
    expect(accepted.editDraft).toBeNull()
    expect(accepted.cardEntries[DETAIL.id].detail?.customer).toMatchObject({
      name: '서버 이름',
      version: 2,
    })
  })

  it('keeps rows visible and exposes errors when deletion fails', () => {
    const taskState = run([
      { type: 'cardLoadSucceeded', detail: DETAIL },
      { type: 'taskDeleteStarted', taskId: 'task-2' },
      {
        type: 'taskDeleteFailed',
        taskId: 'task-2',
        error: {
          conversationId: DETAIL.id,
          scope: 'task',
          status: 500,
          message: '업무를 삭제하지 못했습니다.',
        },
      },
      { type: 'noteDeleteStarted', noteId: 'note-2' },
      {
        type: 'noteDeleteFailed',
        noteId: 'note-2',
        error: {
          conversationId: DETAIL.id,
          scope: 'note',
          status: 403,
          message: '메모를 변경할 수 없습니다.',
        },
      },
    ])

    expect(taskState.cardEntries[DETAIL.id].detail?.tasks).toHaveLength(3)
    expect(taskState.cardEntries[DETAIL.id].detail?.notes).toHaveLength(3)
    expect(taskState.pendingTaskDeletes).toEqual([])
    expect(taskState.pendingNoteDeletes).toEqual([])
    expect(taskState.cardMutationError).toMatchObject({
      scope: 'note',
      status: 403,
    })
  })
})
