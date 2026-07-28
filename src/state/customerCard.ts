import type { AiChatMessage, EditDraft, TaskDraft } from '../types'
import type { ActionHandlers, InboxState } from './inbox'

export interface CustomerCardState {
  editDraft: EditDraft | null
  taskEdit: number | null
  addingTask: boolean
  taskDraft: TaskDraft
  noteEdit: number | null
  addingNote: boolean
  noteDraft: string
  aiChats: Record<string, AiChatMessage[]>
  aiDraft: string
  aiLoading: boolean
}

export const initialCustomerCardState: CustomerCardState = {
  editDraft: null,
  taskEdit: null,
  addingTask: false,
  taskDraft: { name: '', sub: '', kind: 'idle' },
  noteEdit: null,
  addingNote: false,
  noteDraft: '',
  aiChats: {},
  aiDraft: '',
  aiLoading: false,
}

export type CustomerCardAction =
  | { type: 'toggleTodo'; index: number }
  | { type: 'linkFolder' }
  | { type: 'unlinkFolder' }
  | { type: 'startEdit' }
  | { type: 'cancelEdit' }
  | { type: 'saveEdit' }
  | { type: 'setEditName'; value: string }
  | { type: 'setEditOrg'; value: string }
  | { type: 'setEditField'; index: number; value: string }
  | { type: 'addTask' }
  | { type: 'editTask'; index: number }
  | { type: 'cancelTask' }
  | { type: 'saveTask' }
  | { type: 'removeTask'; index: number }
  | { type: 'setTaskDraft'; patch: Partial<TaskDraft> }
  | { type: 'addNote' }
  | { type: 'editNote'; index: number }
  | { type: 'cancelNote' }
  | { type: 'saveNote'; now: number }
  | { type: 'removeNote'; index: number }
  | { type: 'setNoteDraft'; value: string }
  | { type: 'setAiDraft'; value: string }
  | { type: 'askAi'; question: string }
  | { type: 'aiReply'; id: string; text: string }

export const customerCardHandlers = {
  // F5가 채운다.
  toggleTodo: (state, action) => {
    void action.index
    return state
  },

  // F5가 채운다.
  linkFolder: (state) => state,

  // F5가 채운다.
  unlinkFolder: (state) => state,

  // F5가 채운다.
  startEdit: (state) => state,

  cancelEdit: (state) => ({ ...state, editDraft: null }),

  saveEdit: (state) => {
    const draft = state.editDraft
    if (!draft) return state
    // F5가 채운다.
    return {
      ...state,
      editDraft: null,
    }
  },

  setEditName: (state, action) =>
    state.editDraft
      ? { ...state, editDraft: { ...state.editDraft, name: action.value } }
      : state,

  setEditOrg: (state, action) =>
    state.editDraft
      ? { ...state, editDraft: { ...state.editDraft, org: action.value } }
      : state,

  setEditField: (state, action) =>
    state.editDraft
      ? {
          ...state,
          editDraft: {
            ...state.editDraft,
            fields: state.editDraft.fields.map((field, index) =>
              index === action.index ? { ...field, v: action.value } : field,
            ),
          },
        }
      : state,

  addTask: (state) => ({
    ...state,
    addingTask: true,
    taskEdit: null,
    taskDraft: { name: '', sub: '', kind: 'idle' },
  }),

  editTask: (state, action) => {
    // F5가 채운다.
    return {
      ...state,
      taskEdit: action.index,
      addingTask: false,
      taskDraft: { name: '', sub: '', kind: 'idle' },
    }
  },

  cancelTask: (state) => ({
    ...state,
    addingTask: false,
    taskEdit: null,
    taskDraft: { name: '', sub: '', kind: 'idle' },
  }),

  saveTask: (state) => {
    const reset = {
      ...state,
      addingTask: false,
      taskEdit: null,
      taskDraft: { name: '', sub: '', kind: 'idle' as const },
    }
    // F5가 채운다.
    return reset
  },

  removeTask: (state, action) => {
    // F5가 채운다.
    void action.index
    return { ...state, taskEdit: null }
  },

  setTaskDraft: (state, action) => ({
    ...state,
    taskDraft: { ...state.taskDraft, ...action.patch },
  }),

  addNote: (state) => ({
    ...state,
    addingNote: true,
    noteEdit: null,
    noteDraft: '',
  }),

  editNote: (state, action) => ({
    ...state,
    noteEdit: action.index,
    addingNote: false,
    // F5가 채운다.
    noteDraft: '',
  }),

  cancelNote: (state) => ({
    ...state,
    addingNote: false,
    noteEdit: null,
    noteDraft: '',
  }),

  saveNote: (state, action) => {
    const reset = { ...state, addingNote: false, noteEdit: null, noteDraft: '' }
    // F5가 채운다.
    void action.now
    return reset
  },

  removeNote: (state, action) => {
    // F5가 채운다.
    void action.index
    return { ...state, noteEdit: null, noteDraft: '' }
  },

  setNoteDraft: (state, action) => ({ ...state, noteDraft: action.value }),

  setAiDraft: (state, action) => ({ ...state, aiDraft: action.value }),

  askAi: (state, action) => {
    const question = action.question.trim()
    if (!question || state.selected === null) return state
    const id = state.selected
    return {
      ...state,
      aiDraft: '',
      aiLoading: true,
      aiChats: {
        ...state.aiChats,
        [id]: [...(state.aiChats[id] ?? []), { role: 'user', text: question }],
      },
    }
  },

  aiReply: (state, action) => ({
    ...state,
    aiLoading: false,
    aiChats: {
      ...state.aiChats,
      [action.id]: [
        ...(state.aiChats[action.id] ?? []),
        { role: 'ai', text: action.text },
      ],
    },
  }),
} satisfies ActionHandlers<InboxState, CustomerCardAction>
