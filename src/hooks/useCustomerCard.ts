import { useCallback, useEffect } from 'react'
import type { CustomerCard } from '../../shared/wire/card'
import { useAuth } from '../api/AuthGate'
import { ApiRequestError } from '../api/client'
import {
  createNote,
  createTask,
  deleteNote,
  deleteTask,
  getConversationDetail,
  updateCustomer,
  updateNote,
  updateTask,
} from '../api/endpoints'
import { useInbox } from '../state/InboxContext'
import {
  customerUpdateRequest,
  type CardMutationError,
  type CardMutationScope,
  type CustomerCardDataAction,
  type CustomerCardDataState,
  type OptimisticNote,
  type OptimisticTask,
} from '../state/customerCardModel'

export interface CustomerCardController {
  conversationId: string | null
  data: CustomerCardDataState
  sessionUserId: string
  dispatchData: (action: CustomerCardDataAction) => void
  reload: () => void
  saveCustomer: () => void
  saveTask: () => void
  deleteTask: (taskId: string) => void
  saveNote: () => void
  deleteNote: (noteId: string) => void
}

function mutationError(
  scope: CardMutationScope,
  error: unknown,
): CardMutationError {
  return error instanceof ApiRequestError
    ? { scope, message: error.message, status: error.status }
    : {
        scope,
        message: '요청을 처리하는 중 알 수 없는 오류가 발생했습니다.',
      }
}

function conflictCustomer(error: unknown): CustomerCard | undefined {
  if (!(error instanceof ApiRequestError) || error.status !== 409) {
    return undefined
  }
  const detail = error.detail
  if (
    typeof detail !== 'object' ||
    detail === null ||
    !('current' in detail)
  ) {
    return undefined
  }
  const current = detail.current
  if (
    typeof current !== 'object' ||
    current === null ||
    !('id' in current) ||
    typeof current.id !== 'string' ||
    !('version' in current) ||
    typeof current.version !== 'number' ||
    !('fields' in current) ||
    !Array.isArray(current.fields)
  ) {
    return undefined
  }
  return current as CustomerCard
}

export function useCustomerCard(): CustomerCardController {
  const { state, dispatch } = useInbox()
  const { me } = useAuth()
  const conversationId = state.selected
  const data: CustomerCardDataState = state
  const entry = conversationId
    ? data.cardEntries[conversationId]
    : undefined

  const dispatchData = useCallback(
    (action: CustomerCardDataAction) =>
      dispatch({ type: 'cardData', action }),
    [dispatch],
  )

  const load = useCallback(
    () => {
      if (!conversationId) return
      dispatchData({ type: 'cardLoadStarted', conversationId })
      getConversationDetail(conversationId)
        .then(({ conversation }) =>
          dispatchData({
            type: 'cardLoadSucceeded',
            detail: conversation,
          }),
        )
        .catch((error: unknown) => {
          dispatchData({
            type: 'cardLoadFailed',
            conversationId,
            message: mutationError('customer', error).message,
          })
        })
    },
    [conversationId, dispatchData],
  )

  useEffect(() => {
    if (!conversationId || entry) return
    load()
  }, [conversationId, entry, load])

  const saveCustomer = useCallback(() => {
    const draft = data.editDraft
    if (!conversationId || draft?.conversationId !== conversationId) return
    const request = customerUpdateRequest(draft)
    if (!request) {
      dispatchData({ type: 'cancelEdit' })
      return
    }

    dispatchData({ type: 'customerSaveStarted' })
    updateCustomer(draft.id, request)
      .then(({ customer }) =>
        dispatchData({
          type: 'customerSaved',
          conversationId,
          customer,
        }),
      )
      .catch((error: unknown) => {
        const current = conflictCustomer(error)
        dispatchData(
          current
            ? { type: 'customerConflict', current }
            : {
                type: 'cardMutationFailed',
                error: mutationError('customer', error),
              },
        )
      })
  }, [conversationId, data.editDraft, dispatchData])

  const saveTask = useCallback(() => {
    const detail = conversationId
      ? data.cardEntries[conversationId]?.detail
      : undefined
    if (!conversationId || !detail) return

    const draft = {
      name: data.taskDraft.name.trim(),
      sub: data.taskDraft.sub.trim(),
      kind: data.taskDraft.kind,
    }
    if (!draft.name) {
      dispatchData({ type: 'cancelTask' })
      return
    }

    const editingId = data.taskEditId
    if (editingId) {
      const previous = detail.tasks.find(({ id }) => id === editingId)
      if (!previous) return
      dispatchData({
        type: 'taskUpdateOptimistic',
        conversationId,
        taskId: editingId,
        patch: draft,
      })
      updateTask(conversationId, editingId, draft)
        .then(({ task }) =>
          dispatchData({
            type: 'taskUpdateSucceeded',
            conversationId,
            task,
          }),
        )
        .catch((error: unknown) =>
          dispatchData({
            type: 'taskUpdateFailed',
            conversationId,
            previous,
            error: mutationError('task', error),
          }),
        )
      return
    }

    const now = Date.now()
    const optimisticId = `optimistic-task-${crypto.randomUUID()}`
    const optimistic: OptimisticTask = {
      id: optimisticId,
      ...draft,
      sortOrder:
        Math.max(-1, ...detail.tasks.map(({ sortOrder }) => sortOrder)) + 1,
      createdById: me.user.id,
      createdAt: now,
      updatedAt: now,
      optimistic: true,
    }
    dispatchData({
      type: 'taskCreateOptimistic',
      conversationId,
      task: optimistic,
    })
    createTask(conversationId, draft)
      .then(({ task }) =>
        dispatchData({
          type: 'taskCreateSucceeded',
          conversationId,
          optimisticId,
          task,
        }),
      )
      .catch((error: unknown) =>
        dispatchData({
          type: 'taskCreateFailed',
          conversationId,
          optimisticId,
          error: mutationError('task', error),
        }),
      )
  }, [
    conversationId,
    data.cardEntries,
    data.taskDraft,
    data.taskEditId,
    dispatchData,
    me.user.id,
  ])

  const removeTask = useCallback(
    (taskId: string) => {
      if (!conversationId) return
      dispatchData({ type: 'taskDeleteStarted', taskId })
      deleteTask(conversationId, taskId)
        .then(() =>
          dispatchData({
            type: 'taskDeleteSucceeded',
            conversationId,
            taskId,
          }),
        )
        .catch((error: unknown) =>
          dispatchData({
            type: 'taskDeleteFailed',
            taskId,
            error: mutationError('task', error),
          }),
        )
    },
    [conversationId, dispatchData],
  )

  const saveNote = useCallback(() => {
    const detail = conversationId
      ? data.cardEntries[conversationId]?.detail
      : undefined
    if (!conversationId || !detail) return

    const body = data.noteDraft.trim()
    if (!body) {
      dispatchData({ type: 'cancelNote' })
      return
    }

    const editingId = data.noteEditId
    if (editingId) {
      const previous = detail.notes.find(({ id }) => id === editingId)
      if (!previous) return
      dispatchData({
        type: 'noteUpdateOptimistic',
        conversationId,
        noteId: editingId,
        body,
        updatedAt: Date.now(),
      })
      updateNote(conversationId, editingId, body)
        .then(({ note }) =>
          dispatchData({
            type: 'noteUpdateSucceeded',
            conversationId,
            note,
          }),
        )
        .catch((error: unknown) =>
          dispatchData({
            type: 'noteUpdateFailed',
            conversationId,
            previous,
            error: mutationError('note', error),
          }),
        )
      return
    }

    const now = Date.now()
    const optimisticId = `optimistic-note-${crypto.randomUUID()}`
    const optimistic: OptimisticNote = {
      id: optimisticId,
      authorId: me.user.id,
      authorName: me.user.name,
      body,
      createdAt: now,
      updatedAt: now,
      optimistic: true,
    }
    dispatchData({
      type: 'noteCreateOptimistic',
      conversationId,
      note: optimistic,
    })
    createNote(conversationId, body)
      .then(({ note }) =>
        dispatchData({
          type: 'noteCreateSucceeded',
          conversationId,
          optimisticId,
          note,
        }),
      )
      .catch((error: unknown) =>
        dispatchData({
          type: 'noteCreateFailed',
          conversationId,
          optimisticId,
          error: mutationError('note', error),
        }),
      )
  }, [
    conversationId,
    data.cardEntries,
    data.noteDraft,
    data.noteEditId,
    dispatchData,
    me.user.id,
    me.user.name,
  ])

  const removeNote = useCallback(
    (noteId: string) => {
      if (!conversationId) return
      dispatchData({ type: 'noteDeleteStarted', noteId })
      deleteNote(conversationId, noteId)
        .then(() =>
          dispatchData({
            type: 'noteDeleteSucceeded',
            conversationId,
            noteId,
          }),
        )
        .catch((error: unknown) =>
          dispatchData({
            type: 'noteDeleteFailed',
            noteId,
            error: mutationError('note', error),
          }),
        )
    },
    [conversationId, dispatchData],
  )

  return {
    conversationId,
    data,
    sessionUserId: me.user.id,
    dispatchData,
    reload: load,
    saveCustomer,
    saveTask,
    deleteTask: removeTask,
    saveNote,
    deleteNote: removeNote,
  }
}
