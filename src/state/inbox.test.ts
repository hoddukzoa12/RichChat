import { describe, expect, it } from 'vitest'
import {
  ACTION_TYPES,
  initialState,
  reducer,
  type Action,
  type InboxState,
} from './inbox'

const ACTION_TYPES_BEFORE_SPLIT = [
  'select',
  'setPage',
  'setTab',
  'toggleCard',
  'setMobileView',
  'setQuery',
  'setFilter',
  'setScope',
  'setMenu',
  'toggleArchivedView',
  'setStatus',
  'toggleAssignee',
  'clearAssignees',
  'archive',
  'unarchive',
  'setDraft',
  'send',
  'draftReply',
  'toggleTodo',
  'linkFolder',
  'unlinkFolder',
  'startEdit',
  'cancelEdit',
  'saveEdit',
  'setEditName',
  'setEditOrg',
  'setEditField',
  'addTask',
  'editTask',
  'cancelTask',
  'saveTask',
  'removeTask',
  'setTaskDraft',
  'addNote',
  'editNote',
  'cancelNote',
  'saveNote',
  'removeNote',
  'setNoteDraft',
  'setProfile',
  'toggleNotify',
  'toggleAi',
  'toggleOffice',
  'openInvite',
  'closeInvite',
  'setInviteEmail',
  'setInviteRole',
  'sendInvite',
  'setAiDraft',
  'askAi',
  'aiReply',
  'toastArrive',
  'openToast',
  'dismissToast',
] as const satisfies ReadonlyArray<Action['type']>

function run(actions: Action[]): InboxState {
  return actions.reduce(reducer, initialState)
}

describe('inbox reducer', () => {
  it('preserves every action name from before the split', () => {
    expect([...ACTION_TYPES].sort()).toEqual([...ACTION_TYPES_BEFORE_SPLIT].sort())
  })

  it('preserves a representative cross-slice action sequence', () => {
    const messageNow = new Date(2026, 6, 28, 14, 6).getTime()
    const noteNow = new Date(2026, 6, 28, 15, 9).getTime()
    const state = run([
      { type: 'select', id: 2 },
      { type: 'setDraft', value: '  확인 후 전달드리겠습니다.  ' },
      { type: 'send', now: messageNow },
      { type: 'setStatus', value: '완료' },
      { type: 'toggleAssignee', name: '김팀장' },
      { type: 'addNote' },
      { type: 'setNoteDraft', value: '  은행 제출 여부 확인  ' },
      { type: 'saveNote', now: noteNow },
      { type: 'editTask', index: 0 },
      {
        type: 'setTaskDraft',
        patch: { name: '납부 확인서 전달', sub: '7/28 발송', kind: 'done' },
      },
      { type: 'saveTask' },
    ])

    const selectedBefore = initialState.convs.find((conversation) => conversation.id === 2)
    if (!selectedBefore) throw new Error('Expected seeded conversation 2')

    const selectedAfter = {
      ...selectedBefore,
      unread: 0,
      messages: [
        ...selectedBefore.messages,
        {
          dir: 'out' as const,
          text: '확인 후 전달드리겠습니다.',
          time: 'SMS · 오후 2:06',
        },
      ],
      time: '방금',
      status: '완료' as const,
      assignees: [...selectedBefore.assignees, '김팀장'],
      notes: [
        ...selectedBefore.notes,
        {
          author: '박상담',
          time: '7/28 15:09',
          text: '은행 제출 여부 확인',
        },
      ],
      tasks: [
        {
          name: '납부 확인서 전달',
          sub: '7/28 발송',
          badge: '완료',
          kind: 'idle' as const,
        },
      ],
    }

    expect(state).toEqual({
      ...initialState,
      selected: 2,
      mobileView: 'chat',
      convs: initialState.convs.map((conversation) =>
        conversation.id === 2 ? selectedAfter : conversation,
      ),
    })
  })
})
