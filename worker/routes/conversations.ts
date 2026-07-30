import {
  CONVERSATION_LIST_DEFAULT_LIMIT,
  CONVERSATION_LIST_MAX_LIMIT,
  CONVERSATION_SCOPES,
  CONVERSATION_STATUS_FILTERS,
  type ConversationArchiveFilter,
  type ConversationListAssignee,
  type ConversationListFacets,
  type ConversationListItem,
  type ConversationListResponse,
  type ConversationScope,
  type ConversationStatusFilter,
} from '../../shared/wire/conversation'
import type { Status } from '../../shared/domain'
import { executeBatch } from '../db/d1'
import { error } from '../http/error'
import { json } from '../http/respond'
import type { Route } from '../http/router'
import { requireSession, type SessionContext } from '../http/session'

type BindValue = string | number | null

interface SqlFragment {
  sql: string
  values: BindValue[]
}

export interface ConversationListQuery {
  sql: string
  values: BindValue[]
}

interface Cursor {
  lastMessageAt: number | null
  id: string
}

interface ListFilters {
  archive: ConversationArchiveFilter
  scope: ConversationScope
  status: ConversationStatusFilter
  search: string
  phoneSearch: string
  cursor?: Cursor
  limit: number
}

interface PageRow {
  id: string
  office_channel_id: string
  office_channel_label: string
  customer_id: string
  customer_name: string
  customer_company: string
  customer_phone_e164: string
  preview: string
  last_message_at: number | null
  unread_count: number
  assignees_json: string
  status: Status
  label: string
  archived_at: number | null
  version: number
}

interface StatusCountRow {
  status: Status
  count: number
}

interface ScopeCountRow {
  all_count: number
  mine_count: number
  none_count: number
}

interface ArchiveCountRow {
  archive: ConversationArchiveFilter
  count: number
}

const EMPTY_FRAGMENT: SqlFragment = { sql: '', values: [] }

const ARCHIVE_SOURCE: Record<
  ConversationArchiveFilter,
  { index: string; predicate: string }
> = {
  active: {
    index: 'ix_conversations_active_last_message',
    predicate: 'c.archived_at IS NULL',
  },
  archived: {
    index: 'ix_conversations_archived_last_message',
    predicate: 'c.archived_at IS NOT NULL',
  },
}

const SCOPE_FRAGMENT: Record<
  ConversationScope,
  (userId: string) => SqlFragment
> = {
  all: () => EMPTY_FRAGMENT,
  mine: (userId) => ({
    sql: `EXISTS (
      SELECT 1
      FROM conversation_assignees AS selected_assignee
      WHERE selected_assignee.conversation_id = c.id
        AND selected_assignee.user_id = ?
    )`,
    values: [userId],
  }),
  none: () => ({
    sql: `NOT EXISTS (
      SELECT 1
      FROM conversation_assignees AS selected_assignee
      WHERE selected_assignee.conversation_id = c.id
    )`,
    values: [],
  }),
}

const STATUS_FRAGMENT: Record<
  ConversationStatusFilter,
  (status: ConversationStatusFilter) => SqlFragment
> = {
  전체: () => EMPTY_FRAGMENT,
  미처리: (status) => ({ sql: 'c.status = ?', values: [status] }),
  처리중: (status) => ({ sql: 'c.status = ?', values: [status] }),
  완료: (status) => ({ sql: 'c.status = ?', values: [status] }),
}

const ARCHIVED_QUERY_VALUE: Record<'false' | 'true', ConversationArchiveFilter> =
  {
    false: 'active',
    true: 'archived',
  }

function isMember<Value extends string>(
  values: readonly Value[],
  candidate: string,
): candidate is Value {
  return values.includes(candidate as Value)
}

function phoneSearchValue(search: string): string {
  const digits = search.replaceAll(/\D/g, '')
  if (!digits) return ''

  return digits.startsWith('0') ? `82${digits.slice(1)}` : digits
}

function decodeCursor(encoded: string): Cursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined

  try {
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/')
    const padding = '='.repeat((4 - (base64.length % 4)) % 4)
    const value: unknown = JSON.parse(atob(base64 + padding))

    if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1) {
      return undefined
    }

    const lastMessageAt = value[1]
    const id = value[2]
    if (
      (lastMessageAt !== null &&
        (!Number.isSafeInteger(lastMessageAt) || lastMessageAt < 0)) ||
      typeof id !== 'string' ||
      id.length === 0
    ) {
      return undefined
    }

    return { lastMessageAt, id }
  } catch {
    return undefined
  }
}

function encodeCursor(cursor: Cursor): string {
  const base64 = btoa(JSON.stringify([1, cursor.lastMessageAt, cursor.id]))
  return base64
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function parseFilters(url: URL): ListFilters | Response {
  const archived = url.searchParams.get('archived') ?? 'false'
  if (archived !== 'false' && archived !== 'true') {
    return error('BAD_REQUEST', '보관 필터가 올바르지 않습니다.')
  }

  const scope = url.searchParams.get('scope') ?? 'all'
  if (!isMember(CONVERSATION_SCOPES, scope)) {
    return error('BAD_REQUEST', '담당 범위가 올바르지 않습니다.')
  }

  const status = url.searchParams.get('status') ?? '전체'
  if (!isMember(CONVERSATION_STATUS_FILTERS, status)) {
    return error('BAD_REQUEST', '상태 필터가 올바르지 않습니다.')
  }

  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null
    ? CONVERSATION_LIST_DEFAULT_LIMIT
    : Number(rawLimit)
  if (
    (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) ||
    !Number.isSafeInteger(limit) ||
    limit > CONVERSATION_LIST_MAX_LIMIT
  ) {
    return error('BAD_REQUEST', '조회 개수가 올바르지 않습니다.')
  }

  const encodedCursor = url.searchParams.get('cursor')
  const cursor = encodedCursor === null
    ? undefined
    : decodeCursor(encodedCursor)
  if (encodedCursor !== null && cursor === undefined) {
    return error('BAD_REQUEST', '커서가 올바르지 않습니다.')
  }

  const search = (url.searchParams.get('q') ?? '').trim()
  return {
    archive: ARCHIVED_QUERY_VALUE[archived],
    scope,
    status,
    search,
    phoneSearch: phoneSearchValue(search),
    cursor,
    limit,
  }
}

function searchFragment(filters: ListFilters): SqlFragment {
  if (!filters.search) return EMPTY_FRAGMENT

  const textSql = '(instr(customer.name, ?) > 0 OR instr(customer.company, ?) > 0)'
  if (!filters.phoneSearch) {
    return {
      sql: textSql,
      values: [filters.search, filters.search],
    }
  }

  return {
    sql: `(${textSql}
      OR instr(replace(customer.phone_e164, '+', ''), ?) > 0)`,
    values: [filters.search, filters.search, filters.phoneSearch],
  }
}

function joinedSource(archive: ConversationArchiveFilter): string {
  const source = ARCHIVE_SOURCE[archive]
  return `FROM conversations AS c INDEXED BY ${source.index}
    INNER JOIN customers AS customer
      ON customer.id = c.customer_id
      AND customer.office_id = c.office_id
    INNER JOIN office_channels AS office_channel
      ON office_channel.id = c.office_channel_id`
}

function filteredWhere(
  filters: ListFilters,
  session: SessionContext,
  options: {
    includeArchive: boolean
    includeScope: boolean
    includeStatus: boolean
    includeCursor: boolean
  },
  archive = filters.archive,
): SqlFragment {
  const fragments: SqlFragment[] = [
    { sql: 'c.office_id = ?', values: [session.officeId] },
  ]

  if (options.includeArchive) {
    fragments.push({
      sql: ARCHIVE_SOURCE[archive].predicate,
      values: [],
    })
  }
  if (options.includeScope) {
    fragments.push(SCOPE_FRAGMENT[filters.scope](session.userId))
  }
  if (options.includeStatus) {
    fragments.push(STATUS_FRAGMENT[filters.status](filters.status))
  }
  fragments.push(searchFragment(filters))

  if (options.includeCursor && filters.cursor) {
    if (filters.cursor.lastMessageAt === null) {
      fragments.push({
        sql: '(c.last_message_at IS NULL AND c.id < ?)',
        values: [filters.cursor.id],
      })
    } else {
      fragments.push({
        sql: `(
          c.last_message_at < ?
          OR c.last_message_at IS NULL
          OR (c.last_message_at = ? AND c.id < ?)
        )`,
        values: [
          filters.cursor.lastMessageAt,
          filters.cursor.lastMessageAt,
          filters.cursor.id,
        ],
      })
    }
  }

  const active = fragments.filter((fragment) => fragment.sql !== '')
  return {
    sql: active.map((fragment) => fragment.sql).join('\n      AND '),
    values: active.flatMap((fragment) => fragment.values),
  }
}

export function buildConversationPageQuery(
  filters: ListFilters,
  session: SessionContext,
): ConversationListQuery {
  const where = filteredWhere(filters, session, {
    includeArchive: true,
    includeScope: true,
    includeStatus: true,
    includeCursor: true,
  })

  return {
    sql: `SELECT
      c.id,
      office_channel.id AS office_channel_id,
      office_channel.label AS office_channel_label,
      customer.id AS customer_id,
      customer.name AS customer_name,
      customer.company AS customer_company,
      customer.phone_e164 AS customer_phone_e164,
      COALESCE(last_message.body, '') AS preview,
      c.last_message_at,
      MAX(
        c.inbound_count - COALESCE(conversation_read.read_inbound_count, 0),
        0
      ) AS unread_count,
      COALESCE((
        SELECT json_group_array(
          json_object('id', ordered_assignee.user_id, 'name', ordered_assignee.name)
        )
        FROM (
          SELECT assignee.user_id, assigned_user.name
          FROM conversation_assignees AS assignee
          INNER JOIN users AS assigned_user
            ON assigned_user.id = assignee.user_id
          WHERE assignee.conversation_id = c.id
          ORDER BY assignee.assigned_at, assignee.user_id
        ) AS ordered_assignee
      ), '[]') AS assignees_json,
      c.status,
      c.label,
      c.archived_at,
      c.version
    ${joinedSource(filters.archive)}
    LEFT JOIN messages AS last_message
      ON last_message.id = c.last_message_id
      AND last_message.conversation_id = c.id
    LEFT JOIN conversation_reads AS conversation_read
      ON conversation_read.conversation_id = c.id
      AND conversation_read.user_id = ?
    WHERE ${where.sql}
    ORDER BY c.last_message_at DESC, c.id DESC
    LIMIT ?`,
    values: [session.userId, ...where.values, filters.limit + 1],
  }
}

function buildStatusCountQuery(
  filters: ListFilters,
  session: SessionContext,
): ConversationListQuery {
  const where = filteredWhere(filters, session, {
    includeArchive: true,
    includeScope: true,
    includeStatus: false,
    includeCursor: false,
  })

  return {
    sql: `SELECT c.status, COUNT(*) AS count
    ${joinedSource(filters.archive)}
    WHERE ${where.sql}
    GROUP BY c.status`,
    values: where.values,
  }
}

function buildScopeCountQuery(
  filters: ListFilters,
  session: SessionContext,
): ConversationListQuery {
  const where = filteredWhere(filters, session, {
    includeArchive: true,
    includeScope: false,
    includeStatus: true,
    includeCursor: false,
  })

  return {
    sql: `SELECT
      COUNT(*) AS all_count,
      COALESCE(SUM(EXISTS (
        SELECT 1
        FROM conversation_assignees AS mine_assignee
        WHERE mine_assignee.conversation_id = c.id
          AND mine_assignee.user_id = ?
      )), 0) AS mine_count,
      COALESCE(SUM(NOT EXISTS (
        SELECT 1
        FROM conversation_assignees AS any_assignee
        WHERE any_assignee.conversation_id = c.id
      )), 0) AS none_count
    ${joinedSource(filters.archive)}
    WHERE ${where.sql}`,
    values: [session.userId, ...where.values],
  }
}

function buildArchiveCountQuery(
  filters: ListFilters,
  session: SessionContext,
): ConversationListQuery {
  const branch = (archive: ConversationArchiveFilter): ConversationListQuery => {
    const where = filteredWhere(
      filters,
      session,
      {
        includeArchive: true,
        includeScope: true,
        includeStatus: true,
        includeCursor: false,
      },
      archive,
    )

    return {
      sql: `SELECT ? AS archive, COUNT(*) AS count
      ${joinedSource(archive)}
      WHERE ${where.sql}`,
      values: [archive, ...where.values],
    }
  }

  const active = branch('active')
  const archived = branch('archived')
  return {
    sql: `${active.sql}\nUNION ALL\n${archived.sql}`,
    values: [...active.values, ...archived.values],
  }
}

function statusFacets(rows: StatusCountRow[]): ConversationListFacets['status'] {
  const counts: ConversationListFacets['status'] = {
    전체: 0,
    미처리: 0,
    처리중: 0,
    완료: 0,
  }

  for (const row of rows) {
    counts[row.status] = row.count
    counts.전체 += row.count
  }
  return counts
}

function scopeFacets(row: ScopeCountRow | undefined): ConversationListFacets['scope'] {
  return {
    all: row?.all_count ?? 0,
    mine: row?.mine_count ?? 0,
    none: row?.none_count ?? 0,
  }
}

function archiveFacets(
  rows: ArchiveCountRow[],
): ConversationListFacets['archive'] {
  const counts: ConversationListFacets['archive'] = {
    active: 0,
    archived: 0,
  }
  for (const row of rows) counts[row.archive] = row.count
  return counts
}

function itemFromRow(row: PageRow): ConversationListItem {
  return {
    id: row.id,
    officeChannel: {
      id: row.office_channel_id,
      label: row.office_channel_label,
    },
    customer: {
      id: row.customer_id,
      name: row.customer_name,
      company: row.customer_company,
      phoneE164: row.customer_phone_e164,
    },
    preview: row.preview,
    lastMessageAt: row.last_message_at,
    unreadCount: row.unread_count,
    assignees: JSON.parse(row.assignees_json) as ConversationListAssignee[],
    status: row.status,
    label: row.label,
    archived: row.archived_at !== null,
    version: row.version,
  }
}

export async function listConversations(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const filters = parseFilters(new URL(request.url))
  if (filters instanceof Response) return filters

  const page = buildConversationPageQuery(filters, session)
  const status = buildStatusCountQuery(filters, session)
  const scope = buildScopeCountQuery(filters, session)
  const archive = buildArchiveCountQuery(filters, session)
  const results = await executeBatch(env.DB, [
    env.DB.prepare(page.sql).bind(...page.values),
    env.DB.prepare(status.sql).bind(...status.values),
    env.DB.prepare(scope.sql).bind(...scope.values),
    env.DB.prepare(archive.sql).bind(...archive.values),
  ])

  const pageRows = results[0].results as unknown as PageRow[]
  const visibleRows = pageRows.slice(0, filters.limit)
  const lastVisible = visibleRows.at(-1)
  const response: ConversationListResponse = {
    conversations: visibleRows.map(itemFromRow),
    nextCursor: pageRows.length > filters.limit && lastVisible
      ? encodeCursor({
          lastMessageAt: lastVisible.last_message_at,
          id: lastVisible.id,
        })
      : null,
    facets: {
      status: statusFacets(
        results[1].results as unknown as StatusCountRow[],
      ),
      scope: scopeFacets(
        (results[2].results as unknown as ScopeCountRow[])[0],
      ),
      archive: archiveFacets(
        results[3].results as unknown as ArchiveCountRow[],
      ),
    },
  }

  return json(response)
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/conversations',
    handler: listConversations,
  },
]
