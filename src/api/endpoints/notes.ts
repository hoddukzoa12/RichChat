import type { NoteResponse } from '../../../shared/wire/note'
import { apiRequest } from '../client'
import { apiJsonRequest } from './request'

function notesPath(conversationId: string, noteId?: string): string {
  const collection = `/api/conversations/${encodeURIComponent(conversationId)}/notes`
  return noteId === undefined
    ? collection
    : `${collection}/${encodeURIComponent(noteId)}`
}

export function createNote(
  conversationId: string,
  body: string,
  signal?: AbortSignal,
): Promise<NoteResponse> {
  return apiJsonRequest(notesPath(conversationId), 'POST', { body }, signal)
}

export function updateNote(
  conversationId: string,
  noteId: string,
  body: string,
  signal?: AbortSignal,
): Promise<NoteResponse> {
  return apiJsonRequest(
    notesPath(conversationId, noteId),
    'PATCH',
    { body },
    signal,
  )
}

export function deleteNote(
  conversationId: string,
  noteId: string,
  signal?: AbortSignal,
): Promise<void> {
  return apiRequest(notesPath(conversationId, noteId), {
    method: 'DELETE',
    signal,
  })
}
