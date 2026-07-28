import type {
  CustomerCard,
  CustomerFieldChanges,
  CustomerFieldCreate,
  CustomerFieldUpdate,
  CustomerVersionConflictResponse,
  UpdateCustomerResponse,
} from '../../shared/wire/card'
import {
  changes,
  D1BatchError,
} from '../db/d1'
import { publish } from '../db/events'
import { ERROR_STATUS, error } from '../http/error'
import { json } from '../http/respond'
import type { Route } from '../http/router'
import { requireSession } from '../http/session'
import { createId } from '../lib/ids'
import { executeBatchAndBroadcast } from '../realtime/broadcast'

const CUSTOMER_KEYS = new Set([
  'version',
  'name',
  'company',
  'roleTitle',
  'fieldChanges',
])
const PHONE_KEYS = new Set(['phoneE164', 'phone_e164'])
const FIELD_CHANGE_KEYS = new Set(['create', 'update', 'delete'])
const FIELD_CREATE_KEYS = new Set(['key', 'value', 'sortOrder'])
const FIELD_UPDATE_KEYS = new Set([
  'id',
  'key',
  'value',
  'sortOrder',
])
const FIELD_KEY_CONSTRAINT =
  'UNIQUE constraint failed: customer_fields.customer_id, customer_fields.key'

interface CustomerRow {
  id: string
  phone_e164: string
  name: string
  company: string
  role_title: string
  version: number
  updated_at: number
}

interface CustomerFieldRow {
  id: string
  key: string
  value: string
  sort_order: number
  updated_at: number
}

interface ParsedUpdate {
  version: number
  hasName: boolean
  name: string
  hasCompany: boolean
  company: string
  hasRoleTitle: boolean
  roleTitle: string
  fieldChanges: Required<CustomerFieldChanges>
}

interface CustomerRouteDependencies {
  clock?: () => number
  nextId?: () => string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isSortOrder(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

function parseFieldCreate(value: unknown): CustomerFieldCreate | undefined {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, FIELD_CREATE_KEYS) ||
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    typeof value.value !== 'string' ||
    !isSortOrder(value.sortOrder)
  ) {
    return undefined
  }

  return {
    key: value.key,
    value: value.value,
    sortOrder: value.sortOrder,
  }
}

function parseFieldUpdate(value: unknown): CustomerFieldUpdate | undefined {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, FIELD_UPDATE_KEYS) ||
    typeof value.id !== 'string' ||
    value.id.length === 0
  ) {
    return undefined
  }

  const hasKey = Object.hasOwn(value, 'key')
  const hasValue = Object.hasOwn(value, 'value')
  const hasSortOrder = Object.hasOwn(value, 'sortOrder')
  if (!hasKey && !hasValue && !hasSortOrder) return undefined
  if (
    (hasKey &&
      (typeof value.key !== 'string' || value.key.length === 0)) ||
    (hasValue && typeof value.value !== 'string') ||
    (hasSortOrder && !isSortOrder(value.sortOrder))
  ) {
    return undefined
  }

  return {
    id: value.id,
    ...(hasKey ? { key: value.key as string } : {}),
    ...(hasValue ? { value: value.value as string } : {}),
    ...(hasSortOrder ? { sortOrder: value.sortOrder as number } : {}),
  }
}

function parseArray<T>(
  value: unknown,
  parseItem: (item: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined

  const parsed: T[] = []
  for (const item of value) {
    const result = parseItem(item)
    if (!result) return undefined
    parsed.push(result)
  }
  return parsed
}

function parseFieldChanges(
  value: unknown,
): Required<CustomerFieldChanges> | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, FIELD_CHANGE_KEYS)) {
    return undefined
  }

  const create = Object.hasOwn(value, 'create')
    ? parseArray(value.create, parseFieldCreate)
    : []
  const update = Object.hasOwn(value, 'update')
    ? parseArray(value.update, parseFieldUpdate)
    : []
  const deleted = Object.hasOwn(value, 'delete')
    ? parseArray(
        value.delete,
        (item) =>
          typeof item === 'string' && item.length > 0 ? item : undefined,
      )
    : []
  if (!create || !update || !deleted) return undefined

  const updateIds = update.map(({ id }) => id)
  const allTargetIds = [...updateIds, ...deleted]
  if (
    new Set(updateIds).size !== updateIds.length ||
    new Set(deleted).size !== deleted.length ||
    new Set(allTargetIds).size !== allTargetIds.length
  ) {
    return undefined
  }

  return { create, update, delete: deleted }
}

function parseUpdate(value: unknown): ParsedUpdate | undefined {
  if (!isObject(value)) return undefined
  if (Object.keys(value).some((key) => PHONE_KEYS.has(key))) {
    return undefined
  }
  if (!hasOnlyKeys(value, CUSTOMER_KEYS)) return undefined
  if (!Number.isInteger(value.version) || Number(value.version) < 1) {
    return undefined
  }

  const hasName = Object.hasOwn(value, 'name')
  const hasCompany = Object.hasOwn(value, 'company')
  const hasRoleTitle = Object.hasOwn(value, 'roleTitle')
  if (
    (hasName && typeof value.name !== 'string') ||
    (hasCompany && typeof value.company !== 'string') ||
    (hasRoleTitle && typeof value.roleTitle !== 'string')
  ) {
    return undefined
  }

  const hasFieldChanges = Object.hasOwn(value, 'fieldChanges')
  const fieldChanges = hasFieldChanges
    ? parseFieldChanges(value.fieldChanges)
    : { create: [], update: [], delete: [] }
  if (!fieldChanges) return undefined

  const hasFieldMutation =
    fieldChanges.create.length > 0 ||
    fieldChanges.update.length > 0 ||
    fieldChanges.delete.length > 0
  if (!hasName && !hasCompany && !hasRoleTitle && !hasFieldMutation) {
    return undefined
  }

  return {
    version: value.version as number,
    hasName,
    name: hasName ? (value.name as string) : '',
    hasCompany,
    company: hasCompany ? (value.company as string) : '',
    hasRoleTitle,
    roleTitle: hasRoleTitle ? (value.roleTitle as string) : '',
    fieldChanges,
  }
}

async function readCustomer(
  db: D1Database,
  officeId: string,
  customerId: string,
): Promise<CustomerCard | undefined> {
  const customer = await db
    .prepare(
      `SELECT
        id,
        phone_e164,
        name,
        company,
        role_title,
        version,
        updated_at
      FROM customers
      WHERE id = ? AND office_id = ?`,
    )
    .bind(customerId, officeId)
    .first<CustomerRow>()
  if (!customer) return undefined

  const { results: fields } = await db
    .prepare(
      `SELECT id, key, value, sort_order, updated_at
      FROM customer_fields
      WHERE customer_id = ? AND office_id = ?
      ORDER BY sort_order, id`,
    )
    .bind(customerId, officeId)
    .all<CustomerFieldRow>()

  return {
    id: customer.id,
    phoneE164: customer.phone_e164,
    name: customer.name,
    company: customer.company,
    roleTitle: customer.role_title,
    version: customer.version,
    updatedAt: customer.updated_at,
    fields: fields.map((field) => ({
      id: field.id,
      key: field.key,
      value: field.value,
      sortOrder: field.sort_order,
      updatedAt: field.updated_at,
    })),
  }
}

function invalidFieldTarget(
  customer: CustomerCard,
  update: ParsedUpdate,
): boolean {
  if (customer.version !== update.version) return false

  const fieldIds = new Set(customer.fields.map(({ id }) => id))
  return [...update.fieldChanges.update, ...update.fieldChanges.delete].some(
    (target) => {
      const id = typeof target === 'string' ? target : target.id
      return !fieldIds.has(id)
    },
  )
}

function createFieldStatements(
  db: D1Database,
  officeId: string,
  userId: string,
  customerId: string,
  update: ParsedUpdate,
  now: number,
  nextId: () => string,
): D1PreparedStatement[] {
  const versionGuard =
    `EXISTS (
      SELECT 1
      FROM customers
      WHERE id = ? AND office_id = ? AND version = ?
    )`
  const statements: D1PreparedStatement[] = []

  for (const field of update.fieldChanges.create) {
    statements.push(
      db
        .prepare(
          `INSERT INTO customer_fields (
            id,
            customer_id,
            office_id,
            key,
            value,
            sort_order,
            updated_at,
            updated_by
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${versionGuard}`,
        )
        .bind(
          nextId(),
          customerId,
          officeId,
          field.key,
          field.value,
          field.sortOrder,
          now,
          userId,
          customerId,
          officeId,
          update.version,
        ),
    )
  }

  for (const field of update.fieldChanges.update) {
    const hasKey = Object.hasOwn(field, 'key')
    const hasValue = Object.hasOwn(field, 'value')
    const hasSortOrder = Object.hasOwn(field, 'sortOrder')
    statements.push(
      db
        .prepare(
          `UPDATE customer_fields
          SET
            key = CASE WHEN ? = 1 THEN ? ELSE key END,
            value = CASE WHEN ? = 1 THEN ? ELSE value END,
            sort_order = CASE WHEN ? = 1 THEN ? ELSE sort_order END,
            updated_at = ?,
            updated_by = ?
          WHERE id = ?
            AND customer_id = ?
            AND office_id = ?
            AND ${versionGuard}`,
        )
        .bind(
          Number(hasKey),
          hasKey ? field.key : '',
          Number(hasValue),
          hasValue ? field.value : '',
          Number(hasSortOrder),
          hasSortOrder ? field.sortOrder : 0,
          now,
          userId,
          field.id,
          customerId,
          officeId,
          customerId,
          officeId,
          update.version,
        ),
    )
  }

  for (const fieldId of update.fieldChanges.delete) {
    statements.push(
      db
        .prepare(
          `DELETE FROM customer_fields
          WHERE id = ?
            AND customer_id = ?
            AND office_id = ?
            AND ${versionGuard}`,
        )
        .bind(
          fieldId,
          customerId,
          officeId,
          customerId,
          officeId,
          update.version,
        ),
    )
  }

  return statements
}

function isFieldKeyConflict(cause: unknown): boolean {
  const seen = new Set<unknown>()
  let current = cause

  while (current instanceof Error && !seen.has(current)) {
    if (current.message.includes(FIELD_KEY_CONSTRAINT)) return true
    seen.add(current)
    current = current.cause
  }

  return false
}

function versionConflict(current: CustomerCard): Response {
  const body: CustomerVersionConflictResponse = {
    error: {
      code: 'CONFLICT_VERSION',
      message: '다른 사용자가 먼저 고객 정보를 수정했습니다.',
      detail: { current },
    },
  }
  return json(body, { status: ERROR_STATUS.CONFLICT_VERSION })
}

function createPatchCustomer(
  dependencies: CustomerRouteDependencies = {},
) {
  const clock = dependencies.clock ?? Date.now
  const nextId = dependencies.nextId ?? createId

  return async (
    request: Request,
    env: Env,
    params: Readonly<Record<string, string>>,
    ctx?: ExecutionContext,
  ): Promise<Response> => {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return error('BAD_REQUEST', '요청 본문이 올바른 JSON이 아닙니다.')
    }

    const update = parseUpdate(body)
    if (!update) {
      return error('BAD_REQUEST', '고객 수정 요청이 올바르지 않습니다.')
    }

    const customerId = params.id
    const current = await readCustomer(
      env.DB,
      session.officeId,
      customerId,
    )
    if (!current) {
      return error('NOT_FOUND', '고객을 찾을 수 없습니다.')
    }
    if (invalidFieldTarget(current, update)) {
      return error('BAD_REQUEST', '수정할 고객 필드를 찾을 수 없습니다.')
    }

    const now = Math.max(clock(), current.updatedAt + 1)
    const fieldStatements = createFieldStatements(
      env.DB,
      session.officeId,
      session.userId,
      customerId,
      update,
      now,
      nextId,
    )
    const customerStatement = env.DB
      .prepare(
        `UPDATE customers
        SET
          name = CASE WHEN ? = 1 THEN ? ELSE name END,
          company = CASE WHEN ? = 1 THEN ? ELSE company END,
          role_title = CASE WHEN ? = 1 THEN ? ELSE role_title END,
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND office_id = ? AND version = ?`,
      )
      .bind(
        Number(update.hasName),
        update.name,
        Number(update.hasCompany),
        update.company,
        Number(update.hasRoleTitle),
        update.roleTitle,
        now,
        customerId,
        session.officeId,
        update.version,
      )

    const publication = publish(
      env.DB,
      {
        officeId: session.officeId,
        type: 'customer.updated',
        entity: 'customer',
        entityId: customerId,
        actorKind: 'user',
        actorId: session.userId,
        payload: { version: update.version + 1 },
        createdAt: now,
      },
      {
        query: `SELECT 1
                FROM customers
                WHERE id = ?
                  AND office_id = ?
                  AND version = ?
                  AND updated_at = ?`,
        bindings: [
          customerId,
          session.officeId,
          update.version + 1,
          now,
        ],
      },
    )
    const statements = [
      ...fieldStatements,
      customerStatement,
      ...publication,
    ]

    let results: D1Result[]
    try {
      results = await executeBatchAndBroadcast(
        env.DB,
        statements,
        [publication],
        ctx,
        env,
      )
    } catch (cause) {
      if (cause instanceof D1BatchError && isFieldKeyConflict(cause)) {
        return error('CONFLICT', '같은 이름의 고객 필드가 이미 있습니다.')
      }
      return error('INTERNAL_ERROR', '고객 정보를 수정하지 못했습니다.')
    }

    const customerResult = results[fieldStatements.length]
    if (!customerResult || changes(customerResult) === 0) {
      const latest = await readCustomer(
        env.DB,
        session.officeId,
        customerId,
      )
      return latest
        ? versionConflict(latest)
        : error('NOT_FOUND', '고객을 찾을 수 없습니다.')
    }

    const updated = await readCustomer(
      env.DB,
      session.officeId,
      customerId,
    )
    if (!updated) {
      return error('INTERNAL_ERROR', '고객 정보를 수정하지 못했습니다.')
    }

    const response: UpdateCustomerResponse = { customer: updated }
    return json(response)
  }
}

export function createCustomerRoutes(
  dependencies: CustomerRouteDependencies = {},
): Route[] {
  return [
    {
      method: 'PATCH',
      path: '/api/customers/:id',
      handler: createPatchCustomer(dependencies),
    },
  ]
}

export const routes = createCustomerRoutes()
