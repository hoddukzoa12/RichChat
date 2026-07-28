import { ME } from '../data/seed'
import type { AiChatMessage, EditDraft, TaskDraft, TaskKind } from '../types'
import { currentConv, patchSelectedConversation } from './conversations'
import type { ActionHandlers, InboxState } from './inbox'

export interface CustomerCardState {
  editDraft: EditDraft | null
  taskEdit: number | null
  addingTask: boolean
  taskDraft: TaskDraft
  noteEdit: number | null
  addingNote: boolean
  noteDraft: string
  aiChats: Record<number, AiChatMessage[]>
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
  | { type: 'aiReply'; id: number; text: string }

interface SavedTask {
  badge: string
  kind: Extract<TaskKind, 'warn' | 'idle'>
}

const savedTaskByKind: Record<TaskKind, SavedTask> = {
  warn: { badge: '진행', kind: 'warn' },
  idle: { badge: '대기', kind: 'idle' },
  done: { badge: '완료', kind: 'idle' },
}

function noteStamp(now: Date): string {
  return `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes(),
  ).padStart(2, '0')}`
}

export const customerCardHandlers = {
  toggleTodo: (state, action) => ({
    ...state,
    convs: patchSelectedConversation(state, (conversation) => ({
      todos: conversation.todos.map((todo, index) =>
        index === action.index ? { ...todo, done: !todo.done } : todo,
      ),
    })),
  }),

  linkFolder: (state) => ({
    ...state,
    convs: patchSelectedConversation(state, (conversation) => ({
      folderLinked: true,
      folderPath: conversation.folderPath || `/고객사/${conversation.name}`,
      docCount: conversation.docCount || 3,
    })),
  }),

  unlinkFolder: (state) => ({
    ...state,
    convs: patchSelectedConversation(state, () => ({ folderLinked: false })),
  }),

  startEdit: (state) => {
    const conversation = currentConv(state)
    return {
      ...state,
      editDraft: {
        name: conversation.name,
        org: conversation.orgLine,
        fields: conversation.fields.map((field) => ({ ...field })),
      },
    }
  },

  cancelEdit: (state) => ({ ...state, editDraft: null }),

  saveEdit: (state) => {
    const draft = state.editDraft
    if (!draft) return state
    return {
      ...state,
      editDraft: null,
      convs: patchSelectedConversation(state, () => ({
        name: draft.name,
        orgLine: draft.org,
        company: draft.org.split(' · ')[0],
        fields: draft.fields,
      })),
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
    const task = currentConv(state).tasks[action.index]
    return {
      ...state,
      taskEdit: action.index,
      addingTask: false,
      taskDraft: { name: task.name, sub: task.sub, kind: task.kind },
    }
  },

  cancelTask: (state) => ({
    ...state,
    addingTask: false,
    taskEdit: null,
    taskDraft: { name: '', sub: '', kind: 'idle' },
  }),

  saveTask: (state) => {
    const draft = state.taskDraft
    const name = draft.name.trim()
    const reset = {
      ...state,
      addingTask: false,
      taskEdit: null,
      taskDraft: { name: '', sub: '', kind: 'idle' as const },
    }
    if (!name) return reset
    const saved = savedTaskByKind[draft.kind]
    const row = { name, sub: draft.sub, badge: saved.badge, kind: saved.kind }
    const index = state.taskEdit
    return {
      ...reset,
      convs: patchSelectedConversation(state, (conversation) => ({
        tasks:
          index === null
            ? [...conversation.tasks, row]
            : conversation.tasks.map((task, taskIndex) => (taskIndex === index ? row : task)),
      })),
    }
  },

  removeTask: (state, action) => ({
    ...state,
    taskEdit: null,
    convs: patchSelectedConversation(state, (conversation) => ({
      tasks: conversation.tasks.filter((_, index) => index !== action.index),
    })),
  }),

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
    noteDraft: currentConv(state).notes[action.index].text,
  }),

  cancelNote: (state) => ({
    ...state,
    addingNote: false,
    noteEdit: null,
    noteDraft: '',
  }),

  saveNote: (state, action) => {
    const text = state.noteDraft.trim()
    const reset = { ...state, addingNote: false, noteEdit: null, noteDraft: '' }
    if (!text) return reset
    const stamp = noteStamp(new Date(action.now))
    const index = state.noteEdit
    return {
      ...reset,
      convs: patchSelectedConversation(state, (conversation) => ({
        notes:
          index === null
            ? [...conversation.notes, { author: ME, time: stamp, text }]
            : conversation.notes.map((note, noteIndex) =>
                noteIndex === index ? { ...note, text, time: `${stamp} 수정` } : note,
              ),
      })),
    }
  },

  removeNote: (state, action) => ({
    ...state,
    noteEdit: null,
    noteDraft: '',
    convs: patchSelectedConversation(state, (conversation) => ({
      notes: conversation.notes.filter((_, index) => index !== action.index),
    })),
  }),

  setNoteDraft: (state, action) => ({ ...state, noteDraft: action.value }),

  setAiDraft: (state, action) => ({ ...state, aiDraft: action.value }),

  askAi: (state, action) => {
    const question = action.question.trim()
    if (!question) return state
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
