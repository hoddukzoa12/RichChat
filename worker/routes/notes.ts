import type { Note, NoteResponse } from '../../shared/wire/note'
import { changes, executeBatch } from '../db/d1'
import { publish } from '../db/events'
import { error } from '../http/error'
import { json } from '../http/respond'
import type { Route } from '../http/router'
import {
  requireSession,
  type SessionContext,
} from '../http/session'
import { createId, type Clock } from '../lib/ids'

interface NoteRow {
  id: string
  author_id: string
  author_name: string
  body: string
  created_at: number
  updated_at: number
}

interface NoteDependencies {
  clock?: Clock
  idFactory?: () => string
}

type JsonObject = Record<string, unknown>

const NOTE_BODY_KEYS = ['body'] as const
const NOTE_ENTITY = 'note'
const NOTE_EVENT_TYPES = {
  created: 'note.created',
  updated: 'note.updated',
  deleted: 'note.deleted',
} as const

async function readBody(request: Request): Promise<string | Response> {
  let value: unknown

  try {
    value = await request.json()
  } catch {
    return error('BAD_REQUEST', '올바른 JSON 본문이 필요합니다.')
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return error('BAD_REQUEST', 'JSON 객체가 필요합니다.')
  }

  const object = value as JsonObject
  if (
    Object.keys(object).length !== NOTE_BODY_KEYS.length ||
    !Object.hasOwn(object, NOTE_BODY_KEYS[0]) ||
    typeof object.body !== 'string'
  ) {
    return error('BAD_REQUEST', '메모 본문만 보낼 수 있습니다.')
  }

  const body = object.body.trim()
  return body === ''
    ? error('BAD_REQUEST', '메모 본문은 비어 있을 수 없습니다.')
    : body
}

function noteFromRow(row: NoteRow): Note {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function loadActiveNote(
  env: Env,
  session: SessionContext,
  conversationId: string,
  noteId: string,
): Promise<Note | undefined> {
  const row = await env.DB.prepare(
    `SELECT
      notes.id,
      notes.author_id,
      users.name AS author_name,
      notes.body,
      notes.created_at,
      notes.updated_at
    FROM notes
    INNER JOIN users
      ON users.id = notes.author_id
      AND users.office_id = notes.office_id
    WHERE notes.id = ?
      AND notes.conversation_id = ?
      AND notes.office_id = ?
      AND notes.deleted_at IS NULL`,
  )
    .bind(noteId, conversationId, session.officeId)
    .first<NoteRow>()

  return row ? noteFromRow(row) : undefined
}

async function isActiveNoteInAnotherConversation(
  env: Env,
  session: SessionContext,
  conversationId: string,
  noteId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1
    FROM notes
    WHERE id = ?
      AND office_id = ?
      AND author_id = ?
      AND conversation_id <> ?
      AND deleted_at IS NULL`,
  )
    .bind(
      noteId,
      session.officeId,
      session.userId,
      conversationId,
    )
    .first()

  return row !== null
}

function inaccessibleNote(): Response {
  return error('FORBIDDEN', '메모를 변경할 수 없습니다.')
}

async function zeroChangeResponse(
  env: Env,
  session: SessionContext,
  conversationId: string,
  noteId: string,
): Promise<Response> {
  // 경로 위조 404는 자신의 활성 메모에 한해 판별한다. 타인의 존재는 조회하지 않는다.
  if (
    await isActiveNoteInAnotherConversation(
      env,
      session,
      conversationId,
      noteId,
    )
  ) {
    return error('NOT_FOUND', '메모를 찾을 수 없습니다.')
  }

  return inaccessibleNote()
}

export function createNoteRoutes(
  dependencies: NoteDependencies = {},
): Route[] {
  const clock = dependencies.clock ?? Date.now
  const idFactory = dependencies.idFactory ?? createId

  async function createNote(
    request: Request,
    env: Env,
    params: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session

    const body = await readBody(request)
    if (body instanceof Response) return body

    const conversation = await env.DB.prepare(
      `SELECT 1
      FROM conversations
      WHERE id = ?
        AND office_id = ?`,
    )
      .bind(params.id, session.officeId)
      .first()
    if (!conversation) {
      return error('NOT_FOUND', '대화를 찾을 수 없습니다.')
    }

    const noteId = idFactory()
    const now = clock()
    await executeBatch(env.DB, [
      env.DB.prepare(
        `INSERT INTO notes (
          id,
          office_id,
          conversation_id,
          author_id,
          body,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        noteId,
        session.officeId,
        params.id,
        session.userId,
        body,
        now,
        now,
      ),
      ...publish(env.DB, {
        officeId: session.officeId,
        type: NOTE_EVENT_TYPES.created,
        entity: NOTE_ENTITY,
        entityId: noteId,
        conversationId: params.id,
        actorKind: 'user',
        actorId: session.userId,
        payload: { body },
        createdAt: now,
      }),
    ])

    const note = await loadActiveNote(
      env,
      session,
      params.id,
      noteId,
    )
    if (!note) {
      return error('INTERNAL_ERROR', '메모를 불러오지 못했습니다.')
    }

    return json({ note } satisfies NoteResponse, { status: 201 })
  }

  async function updateNote(
    request: Request,
    env: Env,
    params: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session

    const body = await readBody(request)
    if (body instanceof Response) return body

    const now = clock()
    const statements = [
      env.DB.prepare(
        `UPDATE notes
        SET body = ?, updated_at = ?
        WHERE id = ?
          AND conversation_id = ?
          AND office_id = ?
          AND author_id = ?
          AND deleted_at IS NULL`,
      ).bind(
        body,
        now,
        params.noteId,
        params.id,
        session.officeId,
        session.userId,
      ),
      ...publish(
        env.DB,
        {
          officeId: session.officeId,
          type: NOTE_EVENT_TYPES.updated,
          entity: NOTE_ENTITY,
          entityId: params.noteId,
          conversationId: params.id,
          actorKind: 'user',
          actorId: session.userId,
          payload: { body },
          createdAt: now,
        },
        {
          // 과거 삭제 이벤트까지 확인해 동일 밀리초 재시도를 이번 삭제로 오인하지 않는다.
          query: `SELECT 1
                  FROM notes
                  WHERE id = ?
                    AND conversation_id = ?
                    AND office_id = ?
                    AND author_id = ?
                    AND body = ?
                    AND updated_at = ?
                    AND deleted_at IS NULL`,
          bindings: [
            params.noteId,
            params.id,
            session.officeId,
            session.userId,
            body,
            now,
          ],
        },
      ),
    ]
    const [result] = await executeBatch(env.DB, statements)

    if (changes(result) !== 1) {
      return zeroChangeResponse(
        env,
        session,
        params.id,
        params.noteId,
      )
    }

    const note = await loadActiveNote(
      env,
      session,
      params.id,
      params.noteId,
    )
    if (!note) {
      return error('INTERNAL_ERROR', '메모를 불러오지 못했습니다.')
    }

    return json({ note } satisfies NoteResponse)
  }

  async function deleteNote(
    request: Request,
    env: Env,
    params: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session

    const now = clock()
    const statements = [
      env.DB.prepare(
        `UPDATE notes
        SET deleted_at = ?, updated_at = ?
        WHERE id = ?
          AND conversation_id = ?
          AND office_id = ?
          AND author_id = ?
          AND deleted_at IS NULL`,
      ).bind(
        now,
        now,
        params.noteId,
        params.id,
        session.officeId,
        session.userId,
      ),
      ...publish(
        env.DB,
        {
          officeId: session.officeId,
          type: NOTE_EVENT_TYPES.deleted,
          entity: NOTE_ENTITY,
          entityId: params.noteId,
          conversationId: params.id,
          actorKind: 'user',
          actorId: session.userId,
          payload: { deletedAt: now },
          createdAt: now,
        },
        {
          query: `SELECT 1
                  FROM notes
                  WHERE id = ?
                    AND conversation_id = ?
                    AND office_id = ?
                    AND author_id = ?
                    AND deleted_at = ?
                    AND updated_at = ?
                    AND NOT EXISTS (
                      SELECT 1
                      FROM events
                      WHERE office_id = ?
                      AND type = ?
                      AND entity = ?
                      AND entity_id = ?
                    )`,
          bindings: [
            params.noteId,
            params.id,
            session.officeId,
            session.userId,
            now,
            now,
            session.officeId,
            NOTE_EVENT_TYPES.deleted,
            NOTE_ENTITY,
            params.noteId,
          ],
        },
      ),
    ]
    const [result] = await executeBatch(env.DB, statements)

    if (changes(result) !== 1) {
      return zeroChangeResponse(
        env,
        session,
        params.id,
        params.noteId,
      )
    }

    return new Response(null, { status: 204 })
  }

  return [
    {
      method: 'POST',
      path: '/api/conversations/:id/notes',
      handler: createNote,
    },
    {
      method: 'PATCH',
      path: '/api/conversations/:id/notes/:noteId',
      handler: updateNote,
    },
    {
      method: 'DELETE',
      path: '/api/conversations/:id/notes/:noteId',
      handler: deleteNote,
    },
  ]
}

export const routes = createNoteRoutes()
