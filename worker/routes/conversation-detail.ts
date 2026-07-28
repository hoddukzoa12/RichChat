import type { Note } from '../../shared/wire/note'
import type { Task } from '../../shared/wire/task'
import type {
  AttachmentDownloadStatus,
  DeliveryStatus,
  Direction,
  SendChannel,
  Status,
  TaskKind,
} from '../../shared/domain'
import type {
  ConversationAssignee,
  ConversationDetail,
  ConversationDetailResponse,
} from '../../shared/wire/conversation'
import {
  MESSAGE_PAGE_SIZE,
  type ConversationMessage,
  type MessageAttachment,
  type MessagePageResponse,
  type MessageSender,
} from '../../shared/wire/message'
import { error } from '../http/error'
import type { Route, RouteParams } from '../http/router'
import { requireSession } from '../http/session'
import { json } from '../http/respond'

interface DetailRow {
  id: string
  status: Status
  label: string
  archived_at: number | null
  version: number
  customer_id: string
  customer_name: string
  company: string
  role_title: string
  phone_e164: string
  customer_version: number
}

interface CustomerFieldRow {
  id: string
  key: string
  value: string
  sort_order: number
}

interface AssigneeRow {
  id: string
  name: string
  title: string
}

interface TaskRow {
  id: string
  name: string
  sub: string
  kind: TaskKind
  sort_order: number
  created_by: string
  created_at: number
  updated_at: number
}

interface NoteRow {
  id: string
  author_id: string
  author_name: string
  body: string
  created_at: number
  updated_at: number
}

interface ConversationExistsRow {
  id: string
}

interface MessageRow {
  id: string
  direction: Direction
  channel: SendChannel
  title: string | null
  body: string
  sender_user_id: string | null
  sender_name: string | null
  sender_title: string | null
  occurred_at: number
  delivery_status: DeliveryStatus
  result_code: string | null
  delivered_at: number | null
  error_text: string | null
}

interface AttachmentRow {
  id: string
  message_id: string
  original_filename: string | null
  byte_size: number | null
  mime_type: string | null
  download_status: AttachmentDownloadStatus
  created_at: number
}

interface MessageCursor {
  occurredAt: number
  id: string
}

type SenderFactory = (row: MessageRow) => MessageSender | null

const MESSAGE_SENDER: Record<Direction, SenderFactory> = {
  in: () => null,
  out: (row) => ({
    id: row.sender_user_id ?? '',
    name: row.sender_name ?? '',
    title: row.sender_title ?? '',
  }),
}

const THREAD_MESSAGES_SELECT = `SELECT
  messages.id,
  messages.direction,
  messages.channel,
  messages.title,
  messages.body,
  messages.sender_user_id,
  users.name AS sender_name,
  users.title AS sender_title,
  messages.occurred_at,
  messages.delivery_status,
  messages.result_code,
  messages.delivered_at,
  messages.error_text
FROM messages
LEFT JOIN users
  ON users.id = messages.sender_user_id
  AND users.office_id = messages.office_id
WHERE messages.conversation_id = ?
  AND messages.office_id = ?`

const THREAD_MESSAGES_ORDER =
  'ORDER BY messages.occurred_at DESC, messages.id DESC LIMIT ?'

const THREAD_MESSAGES_LATEST_SQL =
  `${THREAD_MESSAGES_SELECT} ${THREAD_MESSAGES_ORDER}`

export const THREAD_MESSAGES_BEFORE_SQL = `${THREAD_MESSAGES_SELECT}
  AND (messages.occurred_at, messages.id) < (?, ?)
  ${THREAD_MESSAGES_ORDER}`

function resultRows<T>(result: D1Result<unknown>): T[] {
  return result.results as T[]
}

function conversationId(params: RouteParams): string {
  return params.id
}

function toAssignee(row: AssigneeRow): ConversationAssignee {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    sub: row.sub,
    kind: row.kind,
    sortOrder: row.sort_order,
    createdById: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function encodeCursor(cursor: MessageCursor): string {
  return btoa(JSON.stringify([cursor.occurredAt, cursor.id]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function decodeCursor(value: string): MessageCursor | undefined {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return undefined
  }

  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padding = '='.repeat((4 - (base64.length % 4)) % 4)
    const decoded: unknown = JSON.parse(atob(base64 + padding))

    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      !Number.isSafeInteger(decoded[0]) ||
      typeof decoded[1] !== 'string' ||
      decoded[1] === ''
    ) {
      return undefined
    }

    return {
      occurredAt: decoded[0],
      id: decoded[1],
    }
  } catch {
    return undefined
  }
}

function pageRequest(
  request: Request,
): { before?: MessageCursor; limit: number } | Response {
  const search = new URL(request.url).searchParams
  const limitValue = search.get('limit')
  const limit =
    limitValue === null ? MESSAGE_PAGE_SIZE : Number(limitValue)

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MESSAGE_PAGE_SIZE
  ) {
    return error('BAD_REQUEST', '메시지 페이지 요청이 올바르지 않습니다.')
  }

  const beforeValue = search.get('before')
  if (beforeValue === null) return { limit }

  const before = decodeCursor(beforeValue)
  if (!before) {
    return error('BAD_REQUEST', '메시지 페이지 요청이 올바르지 않습니다.')
  }

  return { before, limit }
}

async function getConversationDetail(
  request: Request,
  env: Env,
  params: RouteParams,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const id = conversationId(params)
  const results = await env.DB.batch([
    env.DB.prepare(
      `SELECT
        conversations.id,
        conversations.status,
        conversations.label,
        conversations.archived_at,
        conversations.version,
        customers.id AS customer_id,
        customers.name AS customer_name,
        customers.company,
        customers.role_title,
        customers.phone_e164,
        customers.version AS customer_version
      FROM conversations
      INNER JOIN customers
        ON customers.id = conversations.customer_id
        AND customers.office_id = conversations.office_id
      WHERE conversations.id = ?
        AND conversations.office_id = ?`,
    ).bind(id, session.officeId),
    env.DB.prepare(
      `SELECT
        customer_fields.id,
        customer_fields.key,
        customer_fields.value,
        customer_fields.sort_order
      FROM customer_fields
      INNER JOIN conversations
        ON conversations.customer_id = customer_fields.customer_id
        AND conversations.office_id = customer_fields.office_id
      WHERE conversations.id = ?
        AND conversations.office_id = ?
      ORDER BY customer_fields.sort_order, customer_fields.id`,
    ).bind(id, session.officeId),
    env.DB.prepare(
      `SELECT users.id, users.name, users.title
      FROM conversation_assignees
      INNER JOIN users
        ON users.id = conversation_assignees.user_id
        AND users.office_id = conversation_assignees.office_id
      WHERE conversation_assignees.conversation_id = ?
        AND conversation_assignees.office_id = ?
      ORDER BY conversation_assignees.assigned_at, users.id`,
    ).bind(id, session.officeId),
    env.DB.prepare(
      `SELECT
        id,
        name,
        sub,
        kind,
        sort_order,
        created_by,
        created_at,
        updated_at
      FROM tasks
      WHERE conversation_id = ?
        AND office_id = ?
        AND deleted_at IS NULL
      ORDER BY sort_order, id`,
    ).bind(id, session.officeId),
    env.DB.prepare(
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
      WHERE notes.conversation_id = ?
        AND notes.office_id = ?
        AND notes.deleted_at IS NULL
      ORDER BY notes.created_at, notes.id`,
    ).bind(id, session.officeId),
  ])

  const detail = resultRows<DetailRow>(results[0])[0]
  if (!detail) return error('NOT_FOUND', '대화를 찾을 수 없습니다.')

  const fields = resultRows<CustomerFieldRow>(results[1]).map((row) => ({
    id: row.id,
    key: row.key,
    value: row.value,
    sortOrder: row.sort_order,
  }))
  const conversation: ConversationDetail = {
    id: detail.id,
    status: detail.status,
    label: detail.label,
    archived: detail.archived_at !== null,
    version: detail.version,
    customer: {
      id: detail.customer_id,
      name: detail.customer_name,
      company: detail.company,
      roleTitle: detail.role_title,
      phoneE164: detail.phone_e164,
      version: detail.customer_version,
      fields,
    },
    assignees: resultRows<AssigneeRow>(results[2]).map(toAssignee),
    tasks: resultRows<TaskRow>(results[3]).map(toTask),
    notes: resultRows<NoteRow>(results[4]).map(toNote),
  }
  const response: ConversationDetailResponse = { conversation }

  return json(response)
}

function messageStatement(
  db: D1Database,
  conversationIdValue: string,
  officeId: string,
  before: MessageCursor | undefined,
  limit: number,
): D1PreparedStatement {
  if (!before) {
    return db
      .prepare(THREAD_MESSAGES_LATEST_SQL)
      .bind(conversationIdValue, officeId, limit + 1)
  }

  return db
    .prepare(THREAD_MESSAGES_BEFORE_SQL)
    .bind(
      conversationIdValue,
      officeId,
      before.occurredAt,
      before.id,
      limit + 1,
    )
}

async function loadAttachments(
  db: D1Database,
  officeId: string,
  messageIds: string[],
): Promise<Map<string, MessageAttachment[]>> {
  const byMessage = new Map<string, MessageAttachment[]>()
  for (const messageId of messageIds) byMessage.set(messageId, [])
  if (messageIds.length === 0) return byMessage

  const placeholders = messageIds.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT
        id,
        message_id,
        original_filename,
        byte_size,
        mime_type,
        download_status,
        created_at
      FROM message_attachments
      WHERE office_id = ?
        AND message_id IN (${placeholders})
      ORDER BY message_id, created_at, id`,
    )
    .bind(officeId, ...messageIds)
    .all<AttachmentRow>()

  for (const row of results) {
    byMessage.get(row.message_id)?.push({
      id: row.id,
      originalFilename: row.original_filename,
      byteSize: row.byte_size,
      mimeType: row.mime_type,
      downloadStatus: row.download_status,
      createdAt: row.created_at,
    })
  }

  return byMessage
}

function toMessage(
  row: MessageRow,
  attachments: Map<string, MessageAttachment[]>,
): ConversationMessage {
  return {
    id: row.id,
    direction: row.direction,
    channel: row.channel,
    title: row.title,
    body: row.body,
    sender: MESSAGE_SENDER[row.direction](row),
    occurredAt: row.occurred_at,
    deliveryStatus: row.delivery_status,
    resultCode: row.result_code,
    deliveredAt: row.delivered_at,
    errorText: row.error_text,
    attachments: attachments.get(row.id) ?? [],
  }
}

async function getMessages(
  request: Request,
  env: Env,
  params: RouteParams,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const page = pageRequest(request)
  if (page instanceof Response) return page

  const id = conversationId(params)
  const [conversationResult, messagesResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id
      FROM conversations
      WHERE id = ?
        AND office_id = ?`,
    ).bind(id, session.officeId),
    messageStatement(
      env.DB,
      id,
      session.officeId,
      page.before,
      page.limit,
    ),
  ])

  if (resultRows<ConversationExistsRow>(conversationResult).length === 0) {
    return error('NOT_FOUND', '대화를 찾을 수 없습니다.')
  }

  const descendingRows = resultRows<MessageRow>(messagesResult)
  const hasMore = descendingRows.length > page.limit
  const pageRows = descendingRows.slice(0, page.limit)
  const oldest = pageRows.at(-1)
  const attachments = await loadAttachments(
    env.DB,
    session.officeId,
    pageRows.map((row) => row.id),
  )
  const messages = pageRows
    .map((row) => toMessage(row, attachments))
    .reverse()
  const response: MessagePageResponse = {
    messages,
    nextCursor:
      hasMore && oldest
        ? encodeCursor({ occurredAt: oldest.occurred_at, id: oldest.id })
        : null,
  }

  return json(response)
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/conversations/:id',
    handler: getConversationDetail,
  },
  {
    method: 'GET',
    path: '/api/conversations/:id/messages',
    handler: getMessages,
  },
]
