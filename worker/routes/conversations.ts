import {
  CONVERSATION_LIST_DEFAULT_LIMIT,
  CONVERSATION_LIST_MAX_LIMIT,
  CONVERSATION_SCOPES,
  CONVERSATION_STATUS_FILTERS,
  type ConversationArchiveFilter,
  type ConversationListAssignee,
  type ConversationComposeOptionsResponse,
  type ConversationListCustomer,
  type ConversationListFacets,
  type ConversationListItem,
  type ConversationListResponse,
  type ConversationScope,
  type ConversationStartResponse,
  type ConversationStatusFilter,
} from '../../shared/wire/conversation'
import type { Status } from '../../shared/domain'
import {
  conversationOfficeChannelFromRow,
  type ConversationOfficeChannelRow,
} from '../conversation-office-channel'
import { changes, executeBatch } from '../db/d1'
import { publish } from '../db/events'
import { error } from '../http/error'
import { json } from '../http/respond'
import type { Route } from '../http/router'
import { requireSession, type SessionContext } from '../http/session'
import { createId } from '../lib/ids'
import {
  koreanPhoneSearchDigits,
  normalizeKoreanPhoneValue,
} from '../lib/phone'
import { executeBatchAndBroadcast } from '../realtime/broadcast'

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
  sortAt: number
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

interface PageRow extends ConversationOfficeChannelRow {
  id: string
  customer_id: string
  customer_name: string
  customer_company: string
  customer_phone_e164: string
  preview: string
  last_message_at: number | null
  sort_at: number
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

interface ComposePhoneRow {
  id: string
  label: string
  value: string
}

interface ComposeCustomerRow {
  id: string
  name: string
  company: string
  phone_e164: string
}

interface StartedConversationRow {
  id: string
  phone_e164: string
}

interface StartConversationInput {
  officeChannelId: string
  customerId: string | null
  phoneE164: string | null
}

const EMPTY_FRAGMENT: SqlFragment = { sql: '', values: [] }
const COMPOSE_SEARCH_LIMIT = 8
const COMPOSE_QUERY_MAX_LENGTH = 100
const CONVERSATION_CREATED_EVENT = 'conversation.created'
const CONVERSATION_SORT_AT_SQL =
  'COALESCE(c.last_message_at, c.created_at)'

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
  return koreanPhoneSearchDigits(search)
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

    const sortAt = value[1]
    const id = value[2]
    if (
      !Number.isSafeInteger(sortAt) ||
      sortAt < 0 ||
      typeof id !== 'string' ||
      id.length === 0
    ) {
      return undefined
    }

    return { sortAt, id }
  } catch {
    return undefined
  }
}

function encodeCursor(cursor: Cursor): string {
  const base64 = btoa(JSON.stringify([1, cursor.sortAt, cursor.id]))
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
    LEFT JOIN office_channels AS office_channel
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
    fragments.push({
      sql: `(
        ${CONVERSATION_SORT_AT_SQL} < ?
        OR (
          ${CONVERSATION_SORT_AT_SQL} = ?
          AND c.id < ?
        )
      )`,
      values: [
        filters.cursor.sortAt,
        filters.cursor.sortAt,
        filters.cursor.id,
      ],
    })
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
      office_channel.value AS office_channel_value,
      customer.id AS customer_id,
      customer.name AS customer_name,
      customer.company AS customer_company,
      customer.phone_e164 AS customer_phone_e164,
      COALESCE(last_message.body, '') AS preview,
      c.last_message_at,
      ${CONVERSATION_SORT_AT_SQL} AS sort_at,
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
    ORDER BY ${CONVERSATION_SORT_AT_SQL} DESC, c.id DESC
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
    officeChannel: conversationOfficeChannelFromRow(row),
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

function isJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

async function readStartConversation(
  request: Request,
): Promise<StartConversationInput | Response> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    return error('BAD_REQUEST', '올바른 JSON 본문이 필요합니다.')
  }

  if (!isJsonObject(value)) {
    return error('BAD_REQUEST', 'JSON 객체가 필요합니다.')
  }

  const keys = Object.keys(value)
  const hasCustomerId = Object.hasOwn(value, 'customerId')
  const hasPhone = Object.hasOwn(value, 'phone')
  if (
    keys.length !== 2 ||
    !keys.includes('officeChannelId') ||
    hasCustomerId === hasPhone ||
    typeof value.officeChannelId !== 'string' ||
    value.officeChannelId.trim() === ''
  ) {
    return error(
      'BAD_REQUEST',
      '보내는 폰과 받는 사람을 확인해 주세요.',
    )
  }

  if (
    hasCustomerId &&
    (
      typeof value.customerId !== 'string' ||
      value.customerId.trim() === ''
    )
  ) {
    return error('BAD_REQUEST', '받는 고객을 확인해 주세요.')
  }

  if (hasPhone && typeof value.phone !== 'string') {
    return error('BAD_REQUEST', '받는 사람의 전화번호를 확인해 주세요.')
  }

  const phoneE164 = hasPhone
    ? normalizeKoreanPhoneValue(value.phone as string)
    : null
  if (hasPhone && phoneE164 === null) {
    return error(
      'BAD_REQUEST',
      '전화번호를 010-1234-5678 형식으로 입력해 주세요.',
    )
  }

  return {
    officeChannelId: value.officeChannelId.trim(),
    customerId: hasCustomerId
      ? (value.customerId as string).trim()
      : null,
    phoneE164,
  }
}

async function composeOptions(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const query = (new URL(request.url).searchParams.get('q') ?? '').trim()
  if (query.length > COMPOSE_QUERY_MAX_LENGTH) {
    return error('BAD_REQUEST', '고객 검색어가 너무 깁니다.')
  }

  const phoneSearch = koreanPhoneSearchDigits(query)
  const normalizedPhone = normalizeKoreanPhoneValue(query) ?? ''
  const results = await executeBatch(env.DB, [
    env.DB.prepare(
      `SELECT id, label, value
       FROM office_channels
       WHERE office_id = ?
         AND active = 1
         AND device_id IS NOT NULL
       ORDER BY created_at, id`,
    ).bind(session.officeId),
    env.DB.prepare(
      `SELECT id, name, company, phone_e164
       FROM customers
       WHERE office_id = ?
         AND ? <> ''
         AND (
           instr(name, ?) > 0
           OR (
             ? <> ''
             AND instr(replace(phone_e164, '+', ''), ?) > 0
           )
         )
       ORDER BY
         CASE WHEN phone_e164 = ? THEN 0 ELSE 1 END,
         name,
         id
       LIMIT ?`,
    ).bind(
      session.officeId,
      query,
      query,
      phoneSearch,
      phoneSearch,
      normalizedPhone,
      COMPOSE_SEARCH_LIMIT,
    ),
  ])

  const phones = (
    results[0].results as unknown as ComposePhoneRow[]
  ).map(({ id, label, value }) => ({ id, label, value }))
  const customers: ConversationListCustomer[] = (
    results[1].results as unknown as ComposeCustomerRow[]
  ).map((customer) => ({
    id: customer.id,
    name: customer.name,
    company: customer.company,
    phoneE164: customer.phone_e164,
  }))

  return json({
    phones,
    customers,
  } satisfies ConversationComposeOptionsResponse)
}

async function startConversation(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const input = await readStartConversation(request)
  if (input instanceof Response) return input

  const customerId = createId()
  const conversationId = createId()
  const now = Date.now()
  const customerInsert = env.DB.prepare(
    `INSERT INTO customers (
       id, office_id, phone_e164, name, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?
     FROM office_channels AS selected_channel
     WHERE selected_channel.id = ?
       AND selected_channel.office_id = ?
       AND selected_channel.active = 1
       AND selected_channel.device_id IS NOT NULL
       AND ? IS NOT NULL
     ON CONFLICT(office_id, phone_e164) DO NOTHING`,
  ).bind(
    customerId,
    session.officeId,
    input.phoneE164,
    input.phoneE164,
    now,
    now,
    input.officeChannelId,
    session.officeId,
    input.phoneE164,
  )
  const conversationInsert = env.DB.prepare(
    `INSERT INTO conversations (
       id, office_id, customer_id, office_channel_id, status,
       last_message_id, last_message_at, created_at, updated_at
     )
     SELECT
       ?, ?, customer.id, selected_channel.id, '처리중',
       NULL, NULL, ?, ?
     FROM customers AS customer
     INNER JOIN office_channels AS selected_channel
       ON selected_channel.id = ?
       AND selected_channel.office_id = customer.office_id
       AND selected_channel.active = 1
       AND selected_channel.device_id IS NOT NULL
     WHERE customer.office_id = ?
       AND (
         (? IS NOT NULL AND customer.id = ?)
         OR (? IS NOT NULL AND customer.phone_e164 = ?)
       )
     ON CONFLICT(office_id, customer_id, office_channel_id) DO NOTHING`,
  ).bind(
    conversationId,
    session.officeId,
    now,
    now,
    input.officeChannelId,
    session.officeId,
    input.customerId,
    input.customerId,
    input.phoneE164,
    input.phoneE164,
  )
  const publication = publish(
    env.DB,
    {
      officeId: session.officeId,
      type: CONVERSATION_CREATED_EVENT,
      entity: 'conversation',
      entityId: conversationId,
      conversationId,
      actorKind: 'user',
      actorId: session.userId,
      payload: {
        officeChannelId: input.officeChannelId,
        status: '처리중',
      },
      createdAt: now,
    },
    { query: 'SELECT 1 WHERE changes() = 1' },
  )
  const assigneeInsert = env.DB.prepare(
    `INSERT INTO conversation_assignees (
       conversation_id, office_id, user_id, assigned_at, assigned_by
     )
     SELECT id, office_id, ?, ?, ?
     FROM conversations
     WHERE id = ?
     ON CONFLICT(conversation_id, user_id) DO NOTHING`,
  ).bind(
    session.userId,
    now,
    session.userId,
    conversationId,
  )

  let results: D1Result[]
  try {
    results = await executeBatchAndBroadcast(
      env.DB,
      [
        customerInsert,
        conversationInsert,
        ...publication,
        assigneeInsert,
      ],
      [publication],
      ctx,
      env,
    )
  } catch {
    return error('INTERNAL_ERROR', '새 대화를 만들지 못했습니다.')
  }

  const started = await env.DB.prepare(
    `SELECT conversation.id, customer.phone_e164
     FROM conversations AS conversation
     INNER JOIN customers AS customer
       ON customer.id = conversation.customer_id
       AND customer.office_id = conversation.office_id
     WHERE conversation.office_id = ?
       AND conversation.office_channel_id = ?
       AND (
         (? IS NOT NULL AND customer.id = ?)
         OR (? IS NOT NULL AND customer.phone_e164 = ?)
       )`,
  )
    .bind(
      session.officeId,
      input.officeChannelId,
      input.customerId,
      input.customerId,
      input.phoneE164,
      input.phoneE164,
    )
    .first<StartedConversationRow>()

  if (!started) {
    const channel = await env.DB.prepare(
      `SELECT active, device_id
       FROM office_channels
       WHERE id = ? AND office_id = ?`,
    )
      .bind(input.officeChannelId, session.officeId)
      .first<{ active: number; device_id: string | null }>()
    if (!channel) {
      return error('BAD_REQUEST', '보내는 업무폰을 찾을 수 없습니다.')
    }
    if (channel.active !== 1 || channel.device_id === null) {
      return error(
        'CONFLICT',
        '활성 상태인 업무폰을 선택해 주세요.',
      )
    }
    if (input.customerId !== null) {
      return error('NOT_FOUND', '받는 고객을 찾을 수 없습니다.')
    }
    return error('INTERNAL_ERROR', '새 대화를 불러오지 못했습니다.')
  }

  const response: ConversationStartResponse = {
    conversationId: started.id,
    customerPhoneE164: started.phone_e164,
  }
  return json(response, {
    status: changes(results[1]) === 1 ? 201 : 200,
  })
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
          sortAt: lastVisible.sort_at,
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
    path: '/api/conversations/compose',
    handler: composeOptions,
  },
  {
    method: 'POST',
    path: '/api/conversations',
    handler: (request, env, _params, ctx) =>
      startConversation(request, env, ctx),
  },
  {
    method: 'GET',
    path: '/api/conversations',
    handler: listConversations,
  },
]
