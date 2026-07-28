import type {
  ConversationCustomer,
  ConversationCustomerField,
  ConversationDetail,
} from '../../shared/wire/conversation'
import type {
  CustomerCard,
  CustomerFieldChanges,
  UpdateCustomerRequest,
} from '../../shared/wire/card'
import type { Note } from '../../shared/wire/note'
import type { Task } from '../../shared/wire/task'
import type { TaskKind } from '../types'

export type CardLoadStatus = 'idle' | 'loading' | 'ready' | 'failed'
export type CardMutationScope = 'customer' | 'note' | 'task'

export interface CardEntry {
  status: CardLoadStatus
  detail: ConversationDetail | null
  error: string | null
}

export interface DraftCustomerField extends ConversationCustomerField {
  isNew?: true
}

interface EditableCustomer {
  id: string
  name: string
  company: string
  roleTitle: string
  version: number
  fields: DraftCustomerField[]
}

export interface CustomerEditDraft extends EditableCustomer {
  conversationId: string
  base: EditableCustomer
}

export interface CustomerConflict {
  current: CustomerCard
}

export interface CardMutationError {
  scope: CardMutationScope
  message: string
  status?: number
}

export interface TaskDraft {
  name: string
  sub: string
  kind: TaskKind
}

export interface OptimisticTask extends Task {
  optimistic?: true
}

export interface OptimisticNote extends Note {
  optimistic?: true
}

export interface CustomerCardDataState {
  cardEntries: Record<string, CardEntry>
  editDraft: CustomerEditDraft | null
  customerConflict: CustomerConflict | null
  taskEditId: string | null
  addingTask: boolean
  taskDraft: TaskDraft
  pendingTaskDeletes: string[]
  noteEditId: string | null
  addingNote: boolean
  noteDraft: string
  pendingNoteDeletes: string[]
  cardMutationError: CardMutationError | null
}

export const EMPTY_TASK_DRAFT: Readonly<TaskDraft> = {
  name: '',
  sub: '',
  kind: 'idle',
}

export const initialCustomerCardDataState: CustomerCardDataState = {
  cardEntries: {},
  editDraft: null,
  customerConflict: null,
  taskEditId: null,
  addingTask: false,
  taskDraft: { ...EMPTY_TASK_DRAFT },
  pendingTaskDeletes: [],
  noteEditId: null,
  addingNote: false,
  noteDraft: '',
  pendingNoteDeletes: [],
  cardMutationError: null,
}

export type CustomerCardDataAction =
  | { type: 'cardLoadStarted'; conversationId: string }
  | { type: 'cardLoadSucceeded'; detail: ConversationDetail }
  | {
      type: 'cardLoadFailed'
      conversationId: string
      message: string
    }
  | { type: 'startEdit'; conversationId: string }
  | { type: 'cancelEdit' }
  | { type: 'setEditName'; value: string }
  | { type: 'setEditCompany'; value: string }
  | { type: 'setEditRoleTitle'; value: string }
  | {
      type: 'setEditField'
      fieldId: string
      patch: Partial<Pick<DraftCustomerField, 'key' | 'value'>>
    }
  | { type: 'addEditField'; fieldId: string }
  | { type: 'removeEditField'; fieldId: string }
  | {
      type: 'customerSaved'
      conversationId: string
      customer: CustomerCard
    }
  | { type: 'customerConflict'; current: CustomerCard }
  | { type: 'useServerCustomer' }
  | { type: 'rebaseCustomerEdit' }
  | { type: 'addTask' }
  | { type: 'editTask'; conversationId: string; taskId: string }
  | { type: 'cancelTask' }
  | { type: 'setTaskDraft'; patch: Partial<TaskDraft> }
  | {
      type: 'taskCreateOptimistic'
      conversationId: string
      task: OptimisticTask
    }
  | {
      type: 'taskCreateSucceeded'
      conversationId: string
      optimisticId: string
      task: Task
    }
  | {
      type: 'taskCreateFailed'
      conversationId: string
      optimisticId: string
      error: CardMutationError
    }
  | {
      type: 'taskUpdateOptimistic'
      conversationId: string
      taskId: string
      patch: TaskDraft
    }
  | {
      type: 'taskUpdateSucceeded'
      conversationId: string
      task: Task
    }
  | {
      type: 'taskUpdateFailed'
      conversationId: string
      previous: Task
      error: CardMutationError
    }
  | {
      type: 'taskDeleteStarted'
      taskId: string
    }
  | {
      type: 'taskDeleteSucceeded'
      conversationId: string
      taskId: string
    }
  | {
      type: 'taskDeleteFailed'
      taskId: string
      error: CardMutationError
    }
  | { type: 'addNote' }
  | { type: 'editNote'; conversationId: string; noteId: string }
  | { type: 'cancelNote' }
  | { type: 'setNoteDraft'; value: string }
  | {
      type: 'noteCreateOptimistic'
      conversationId: string
      note: OptimisticNote
    }
  | {
      type: 'noteCreateSucceeded'
      conversationId: string
      optimisticId: string
      note: Note
    }
  | {
      type: 'noteCreateFailed'
      conversationId: string
      optimisticId: string
      error: CardMutationError
    }
  | {
      type: 'noteUpdateOptimistic'
      conversationId: string
      noteId: string
      body: string
      updatedAt: number
    }
  | {
      type: 'noteUpdateSucceeded'
      conversationId: string
      note: Note
    }
  | {
      type: 'noteUpdateFailed'
      conversationId: string
      previous: Note
      error: CardMutationError
    }
  | {
      type: 'noteDeleteStarted'
      noteId: string
    }
  | {
      type: 'noteDeleteSucceeded'
      conversationId: string
      noteId: string
    }
  | {
      type: 'noteDeleteFailed'
      noteId: string
      error: CardMutationError
    }
  | { type: 'clearCardMutationError' }

function editableCustomer(
  customer: ConversationCustomer | CustomerCard,
): EditableCustomer {
  return {
    id: customer.id,
    name: customer.name,
    company: customer.company,
    roleTitle: customer.roleTitle,
    version: customer.version,
    fields: customer.fields.map((field) => ({
      id: field.id,
      key: field.key,
      value: field.value,
      sortOrder: field.sortOrder,
    })),
  }
}

function conversationCustomer(customer: CustomerCard): ConversationCustomer {
  return {
    ...editableCustomer(customer),
    phoneE164: customer.phoneE164,
  }
}

function cloneEditable(customer: EditableCustomer): EditableCustomer {
  return {
    ...customer,
    fields: customer.fields.map((field) => ({ ...field })),
  }
}

function updateDetail(
  state: CustomerCardDataState,
  conversationId: string,
  update: (detail: ConversationDetail) => ConversationDetail,
): CustomerCardDataState {
  const entry = state.cardEntries[conversationId]
  if (!entry?.detail) return state

  return {
    ...state,
    cardEntries: {
      ...state.cardEntries,
      [conversationId]: {
        ...entry,
        detail: update(entry.detail),
      },
    },
  }
}

function replaceByRequestItem<T extends { id: string }>(
  items: T[],
  item: T,
  optimisticId?: string,
): T[] {
  const optimisticIndex =
    optimisticId === undefined
      ? -1
      : items.findIndex(({ id }) => id === optimisticId)
  const serverIndex = items.findIndex(({ id }) => id === item.id)
  const targetIndex = optimisticIndex >= 0 ? optimisticIndex : serverIndex
  if (targetIndex < 0) return [...items, item]

  return items.map((current, index) => (index === targetIndex ? item : current))
}

function withoutValue(values: string[], value: string): string[] {
  return values.filter((current) => current !== value)
}

function resetTaskEditor<State extends CustomerCardDataState>(
  state: State,
): State {
  return {
    ...state,
    addingTask: false,
    taskEditId: null,
    taskDraft: { ...EMPTY_TASK_DRAFT },
  }
}

function resetNoteEditor<State extends CustomerCardDataState>(
  state: State,
): State {
  return {
    ...state,
    addingNote: false,
    noteEditId: null,
    noteDraft: '',
  }
}

function changedField(
  current: DraftCustomerField,
  base: DraftCustomerField,
): boolean {
  return (
    current.key !== base.key ||
    current.value !== base.value ||
    current.sortOrder !== base.sortOrder
  )
}

export function customerUpdateRequest(
  draft: CustomerEditDraft,
): UpdateCustomerRequest | null {
  const baseFields = new Map(
    draft.base.fields.map((field) => [field.id, field]),
  )
  const currentIds = new Set(draft.fields.map(({ id }) => id))
  const fieldChanges: CustomerFieldChanges = {
    create: draft.fields
      .filter(({ isNew }) => isNew)
      .map(({ key, value, sortOrder }) => ({ key, value, sortOrder })),
    update: draft.fields.flatMap((field) => {
      if (field.isNew) return []
      const base = baseFields.get(field.id)
      if (!base || !changedField(field, base)) return []
      return [
        {
          id: field.id,
          key: field.key,
          value: field.value,
          sortOrder: field.sortOrder,
        },
      ]
    }),
    delete: draft.base.fields
      .filter(({ id }) => !currentIds.has(id))
      .map(({ id }) => id),
  }

  const request: UpdateCustomerRequest = { version: draft.version }
  if (draft.name !== draft.base.name) request.name = draft.name
  if (draft.company !== draft.base.company) {
    request.company = draft.company
  }
  if (draft.roleTitle !== draft.base.roleTitle) {
    request.roleTitle = draft.roleTitle
  }

  if (
    fieldChanges.create?.length ||
    fieldChanges.update?.length ||
    fieldChanges.delete?.length
  ) {
    request.fieldChanges = fieldChanges
  }

  return Object.keys(request).length === 1 ? null : request
}

function fieldChangedByUser(
  field: DraftCustomerField,
  base: DraftCustomerField,
): boolean {
  return changedField(field, base)
}

function rebasedDraft(
  draft: CustomerEditDraft,
  current: CustomerCard,
): CustomerEditDraft {
  const currentEditable = editableCustomer(current)
  const baseFields = new Map(
    draft.base.fields.map((field) => [field.id, field]),
  )
  const draftFields = new Map(draft.fields.map((field) => [field.id, field]))
  const rebasedFields: DraftCustomerField[] = []

  for (const serverField of currentEditable.fields) {
    const baseField = baseFields.get(serverField.id)
    if (!baseField) {
      rebasedFields.push({ ...serverField })
      continue
    }

    const localField = draftFields.get(serverField.id)
    if (!localField) continue
    rebasedFields.push(
      fieldChangedByUser(localField, baseField)
        ? { ...localField, sortOrder: serverField.sortOrder }
        : { ...serverField },
    )
  }

  for (const localField of draft.fields) {
    const serverHasField = currentEditable.fields.some(
      ({ id }) => id === localField.id,
    )
    const baseField = baseFields.get(localField.id)
    if (localField.isNew && !serverHasField) {
      rebasedFields.push({ ...localField })
    } else if (
      baseField &&
      !serverHasField &&
      fieldChangedByUser(localField, baseField)
    ) {
      rebasedFields.push({
        ...localField,
        id: `rebased-${localField.id}`,
        isNew: true,
      })
    }
  }

  const base = cloneEditable(currentEditable)
  return {
    conversationId: draft.conversationId,
    ...cloneEditable(currentEditable),
    name: draft.name !== draft.base.name ? draft.name : current.name,
    company:
      draft.company !== draft.base.company ? draft.company : current.company,
    roleTitle:
      draft.roleTitle !== draft.base.roleTitle
        ? draft.roleTitle
        : current.roleTitle,
    fields: rebasedFields.map((field, sortOrder) => ({
      ...field,
      sortOrder,
    })),
    base,
  }
}

function errorState(
  state: CustomerCardDataState,
  error: CardMutationError,
): CustomerCardDataState {
  return { ...state, cardMutationError: error }
}

type CustomerCardDataHandlers = {
  [Type in CustomerCardDataAction['type']]: (
    state: CustomerCardDataState,
    action: Extract<CustomerCardDataAction, { type: Type }>,
  ) => CustomerCardDataState
}

export const customerCardDataHandlers = {
  cardLoadStarted: (state, action) => {
    const current = state.cardEntries[action.conversationId]
    return {
      ...state,
      cardEntries: {
        ...state.cardEntries,
        [action.conversationId]: {
          status: 'loading',
          detail: current?.detail ?? null,
          error: null,
        },
      },
    }
  },

  cardLoadSucceeded: (state, action) => {
    return {
      ...state,
      cardEntries: {
        ...state.cardEntries,
        [action.detail.id]: {
          status: 'ready',
          detail: action.detail,
          error: null,
        },
      },
    }
  },

  cardLoadFailed: (state, action) => {
    return {
      ...state,
      cardEntries: {
        ...state.cardEntries,
        [action.conversationId]: {
          status: 'failed',
          detail: state.cardEntries[action.conversationId]?.detail ?? null,
          error: action.message,
        },
      },
    }
  },

  startEdit: (state, action) => {
    const customer = state.cardEntries[action.conversationId]?.detail?.customer
    if (!customer) return state
    const editable = editableCustomer(customer)
    return {
      ...state,
      editDraft: {
        conversationId: action.conversationId,
        ...cloneEditable(editable),
        base: cloneEditable(editable),
      },
      customerConflict: null,
      cardMutationError: null,
    }
  },

  cancelEdit: (state, _action) => {
    return {
      ...state,
      editDraft: null,
      customerConflict: null,
    }
  },

  setEditName: (state, action) => {
    return state.editDraft
      ? {
          ...state,
          editDraft: { ...state.editDraft, name: action.value },
        }
      : state
  },

  setEditCompany: (state, action) => {
    return state.editDraft
      ? {
          ...state,
          editDraft: { ...state.editDraft, company: action.value },
        }
      : state
  },

  setEditRoleTitle: (state, action) => {
    return state.editDraft
      ? {
          ...state,
          editDraft: { ...state.editDraft, roleTitle: action.value },
        }
      : state
  },

  setEditField: (state, action) => {
    return state.editDraft
      ? {
          ...state,
          editDraft: {
            ...state.editDraft,
            fields: state.editDraft.fields.map((field) =>
              field.id === action.fieldId
                ? { ...field, ...action.patch }
                : field,
            ),
          },
        }
      : state
  },

  addEditField: (state, action) => {
    return state.editDraft
      ? {
          ...state,
          editDraft: {
            ...state.editDraft,
            fields: [
              ...state.editDraft.fields,
              {
                id: action.fieldId,
                key: '',
                value: '',
                sortOrder: state.editDraft.fields.length,
                isNew: true,
              },
            ],
          },
        }
      : state
  },

  removeEditField: (state, action) => {
    return state.editDraft
      ? {
          ...state,
          editDraft: {
            ...state.editDraft,
            fields: state.editDraft.fields
              .filter(({ id }) => id !== action.fieldId)
              .map((field, sortOrder) => ({ ...field, sortOrder })),
          },
        }
      : state
  },

  customerSaved: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      customer: conversationCustomer(action.customer),
    }))
    return {
      ...updated,
      editDraft: null,
      customerConflict: null,
      cardMutationError: null,
    }
  },

  customerConflict: (state, action) => {
    return {
      ...state,
      customerConflict: { current: action.current },
      cardMutationError: null,
    }
  },

  useServerCustomer: (state, _action) => {
    const draft = state.editDraft
    const conflict = state.customerConflict
    if (!draft || !conflict) return state
    const updated = updateDetail(state, draft.conversationId, (detail) => ({
      ...detail,
      customer: conversationCustomer(conflict.current),
    }))
    return {
      ...updated,
      editDraft: null,
      customerConflict: null,
    }
  },

  rebaseCustomerEdit: (state, _action) => {
    return state.editDraft && state.customerConflict
      ? {
          ...state,
          editDraft: rebasedDraft(
            state.editDraft,
            state.customerConflict.current,
          ),
          customerConflict: null,
        }
      : state
  },

  addTask: (state, _action) => {
    return {
      ...resetTaskEditor(state),
      addingTask: true,
      cardMutationError: null,
    }
  },

  editTask: (state, action) => {
    const task = state.cardEntries[action.conversationId]?.detail?.tasks.find(
      ({ id }) => id === action.taskId,
    )
    if (!task) return state
    return {
      ...state,
      addingTask: false,
      taskEditId: task.id,
      taskDraft: {
        name: task.name,
        sub: task.sub,
        kind: task.kind,
      },
      cardMutationError: null,
    }
  },

  cancelTask: (state, _action) => {
    return resetTaskEditor(state)
  },

  setTaskDraft: (state, action) => {
    return {
      ...state,
      taskDraft: { ...state.taskDraft, ...action.patch },
    }
  },

  taskCreateOptimistic: (state, action) => {
    const updated = updateDetail(
      resetTaskEditor(state),
      action.conversationId,
      (detail) => ({
        ...detail,
        tasks: [...detail.tasks, action.task],
      }),
    )
    return { ...updated, cardMutationError: null }
  },

  taskCreateSucceeded: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      tasks: replaceByRequestItem(
        detail.tasks,
        action.task,
        action.optimisticId,
      ),
    }))
    return { ...updated, cardMutationError: null }
  },

  taskCreateFailed: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      tasks: detail.tasks.filter(({ id }) => id !== action.optimisticId),
    }))
    return errorState(updated, action.error)
  },

  taskUpdateOptimistic: (state, action) => {
    const updated = updateDetail(
      resetTaskEditor(state),
      action.conversationId,
      (detail) => ({
        ...detail,
        tasks: detail.tasks.map((task) =>
          task.id === action.taskId ? { ...task, ...action.patch } : task,
        ),
      }),
    )
    return { ...updated, cardMutationError: null }
  },

  taskUpdateSucceeded: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      tasks: replaceByRequestItem(detail.tasks, action.task),
    }))
    return { ...updated, cardMutationError: null }
  },

  taskUpdateFailed: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      tasks: replaceByRequestItem(detail.tasks, action.previous),
    }))
    return errorState(updated, action.error)
  },

  taskDeleteStarted: (state, action) => {
    return {
      ...state,
      pendingTaskDeletes: [...state.pendingTaskDeletes, action.taskId],
      cardMutationError: null,
    }
  },

  taskDeleteSucceeded: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      tasks: detail.tasks.filter(({ id }) => id !== action.taskId),
    }))
    return {
      ...updated,
      pendingTaskDeletes: withoutValue(
        updated.pendingTaskDeletes,
        action.taskId,
      ),
      cardMutationError: null,
    }
  },

  taskDeleteFailed: (state, action) => {
    return {
      ...errorState(state, action.error),
      pendingTaskDeletes: withoutValue(state.pendingTaskDeletes, action.taskId),
    }
  },

  addNote: (state, _action) => {
    return {
      ...resetNoteEditor(state),
      addingNote: true,
      cardMutationError: null,
    }
  },

  editNote: (state, action) => {
    const note = state.cardEntries[action.conversationId]?.detail?.notes.find(
      ({ id }) => id === action.noteId,
    )
    if (!note) return state
    return {
      ...state,
      addingNote: false,
      noteEditId: note.id,
      noteDraft: note.body,
      cardMutationError: null,
    }
  },

  cancelNote: (state, _action) => {
    return resetNoteEditor(state)
  },

  setNoteDraft: (state, action) => {
    return { ...state, noteDraft: action.value }
  },

  noteCreateOptimistic: (state, action) => {
    const updated = updateDetail(
      resetNoteEditor(state),
      action.conversationId,
      (detail) => ({
        ...detail,
        notes: [...detail.notes, action.note],
      }),
    )
    return { ...updated, cardMutationError: null }
  },

  noteCreateSucceeded: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      notes: replaceByRequestItem(
        detail.notes,
        action.note,
        action.optimisticId,
      ),
    }))
    return { ...updated, cardMutationError: null }
  },

  noteCreateFailed: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      notes: detail.notes.filter(({ id }) => id !== action.optimisticId),
    }))
    return errorState(updated, action.error)
  },

  noteUpdateOptimistic: (state, action) => {
    const updated = updateDetail(
      resetNoteEditor(state),
      action.conversationId,
      (detail) => ({
        ...detail,
        notes: detail.notes.map((note) =>
          note.id === action.noteId
            ? {
                ...note,
                body: action.body,
                updatedAt: action.updatedAt,
              }
            : note,
        ),
      }),
    )
    return { ...updated, cardMutationError: null }
  },

  noteUpdateSucceeded: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      notes: replaceByRequestItem(detail.notes, action.note),
    }))
    return { ...updated, cardMutationError: null }
  },

  noteUpdateFailed: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      notes: replaceByRequestItem(detail.notes, action.previous),
    }))
    return errorState(updated, action.error)
  },

  noteDeleteStarted: (state, action) => {
    return {
      ...state,
      pendingNoteDeletes: [...state.pendingNoteDeletes, action.noteId],
      cardMutationError: null,
    }
  },

  noteDeleteSucceeded: (state, action) => {
    const updated = updateDetail(state, action.conversationId, (detail) => ({
      ...detail,
      notes: detail.notes.filter(({ id }) => id !== action.noteId),
    }))
    return {
      ...updated,
      pendingNoteDeletes: withoutValue(
        updated.pendingNoteDeletes,
        action.noteId,
      ),
      cardMutationError: null,
    }
  },

  noteDeleteFailed: (state, action) => {
    return {
      ...errorState(state, action.error),
      pendingNoteDeletes: withoutValue(state.pendingNoteDeletes, action.noteId),
    }
  },

  clearCardMutationError: (state, _action) => {
    return { ...state, cardMutationError: null }
  },
} satisfies CustomerCardDataHandlers

export function reduceCustomerCardData(
  state: CustomerCardDataState,
  action: CustomerCardDataAction,
): CustomerCardDataState {
  const handler = customerCardDataHandlers[action.type] as (
    current: CustomerCardDataState,
    nextAction: never,
  ) => CustomerCardDataState
  return handler(state, action as never)
}
