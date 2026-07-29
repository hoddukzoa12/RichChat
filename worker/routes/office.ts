import {
  ROLES,
  USER_STATUSES,
  type Role,
  type UserStatus,
} from '../../shared/domain'
import { canonicalizeEmail } from '../../shared/email'
import {
  hasPermission,
  PERMISSIONS,
  type Permission,
} from '../../shared/permissions'
import {
  MEMBER_STATUS_VALUES,
  RETENTION_YEARS_MAX,
  RETENTION_YEARS_MIN,
  type MemberStatus,
  type OfficeInviteRequest,
  type OfficeInviteResponse,
  type OfficeMember,
  type OfficeMemberPatch,
  type OfficeMemberResponse,
  type OfficeMembersResponse,
  type OfficeMemberStatusPatch,
  type OfficeMemberWithStatus,
  type OfficeSettings,
  type OfficeSettingsPatch,
  type OfficeSettingsResponse,
} from '../../shared/wire/office'
import { changes } from '../db/d1'
import { publish } from '../db/events'
import { error } from '../http/error'
import { json } from '../http/respond'
import type { Route } from '../http/router'
import {
  requireSession,
  type SessionContext,
} from '../http/session'
import { createId, type Clock } from '../lib/ids'
import { executeBatchAndBroadcast } from '../realtime/broadcast'

interface OfficeDependencies {
  clock?: Clock
  idFactory?: () => string
}

interface OfficeSettingsRow {
  export_log: number
  retention_years: number
  updated_at: number
  updated_by: string | null
}

interface OfficeMemberRow {
  id: string
  email: string
  name: string
  title: string
  role: Role
  status: UserStatus
}

interface ListedOfficeMemberRow extends OfficeMemberRow {
  can_manage: number
}

interface SqlGuard {
  sql: string
  bindings: readonly unknown[]
}

type JsonObject = Record<string, unknown>

const SETTINGS_PATCH_KEYS = new Set([
  'exportLog',
  'retentionYears',
])
const INVITE_KEYS = new Set(['email', 'name', 'title', 'role'])
const MEMBER_PATCH_KEYS = new Set(['name', 'title', 'role'])
const MEMBER_STATUS_KEYS = new Set(['status'])
const ROLE_SET = new Set<string>(ROLES)
const MEMBER_STATUS_SET = new Set<string>(MEMBER_STATUS_VALUES)
const EMAIL_MAX_LENGTH = 254
const EMAIL_LOCAL_MAX_LENGTH = 64
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const ADMIN_ROLE = '관리자' satisfies Role
const [INVITED_STATUS, ACTIVE_STATUS, INACTIVE_STATUS] =
  USER_STATUSES
const SETTINGS_ENTITY = 'office_settings'
const SETTINGS_UPDATED_EVENT = 'office.settings.updated'
const MEMBER_ENTITY = 'user'
const MEMBER_EVENT_TYPES = {
  invited: 'office.member.invited',
  updated: 'office.member.updated',
  statusChanged: 'office.member.status-changed',
} as const

const PERMISSION_ROLES = PERMISSIONS.reduce<
  Record<Permission, readonly Role[]>
>(
  (roles, permission) => {
    roles[permission] = ROLES.filter((role) =>
      hasPermission(role, permission),
    )
    return roles
  },
  {} as Record<Permission, readonly Role[]>,
)

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function actorPermissionGuard(
  userId: string,
  permission: Permission,
  alias: string,
): SqlGuard {
  const roles = PERMISSION_ROLES[permission]
  return {
    sql: `EXISTS (
      SELECT 1
      FROM users AS ${alias}
      WHERE ${alias}.id = ?
        AND ${alias}.status = ?
        AND ${alias}.role IN (${placeholders(roles)})
    )`,
    bindings: [userId, ACTIVE_STATUS, ...roles],
  }
}

function permissionAuthorizationProbe(
  db: D1Database,
  userId: string,
  permission: Permission,
): D1PreparedStatement {
  const roles = PERMISSION_ROLES[permission]
  return db.prepare(
    `UPDATE users
    SET role = role
    WHERE id = ?
      AND status = ?
      AND role IN (${placeholders(roles)})`,
  ).bind(userId, ACTIVE_STATUS, ...roles)
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

async function readJsonObject(
  request: Request,
): Promise<JsonObject | Response> {
  let value: unknown

  try {
    value = await request.json()
  } catch {
    return error('BAD_REQUEST', '올바른 JSON 본문이 필요합니다.')
  }

  return isJsonObject(value)
    ? value
    : error('BAD_REQUEST', 'JSON 객체가 필요합니다.')
}

function hasExactKeys(
  value: JsonObject,
  keys: ReadonlySet<string>,
): boolean {
  const received = Object.keys(value)
  return (
    received.length === keys.size &&
    received.every((key) => keys.has(key))
  )
}

function hasOnlyKeys(
  value: JsonObject,
  keys: ReadonlySet<string>,
): boolean {
  const received = Object.keys(value)
  return (
    received.length > 0 &&
    received.every((key) => keys.has(key))
  )
}

async function readSettingsPatch(
  request: Request,
): Promise<OfficeSettingsPatch | Response> {
  const value = await readJsonObject(request)
  if (value instanceof Response) return value

  if (!hasOnlyKeys(value, SETTINGS_PATCH_KEYS)) {
    return error(
      'BAD_REQUEST',
      '변경할 사무소 설정만 보낼 수 있습니다.',
    )
  }

  if (
    Object.hasOwn(value, 'exportLog') &&
    typeof value.exportLog !== 'boolean'
  ) {
    return error(
      'BAD_REQUEST',
      '내보내기 기록 설정이 올바르지 않습니다.',
    )
  }

  if (
    Object.hasOwn(value, 'retentionYears') &&
    (
      typeof value.retentionYears !== 'number' ||
      !Number.isInteger(value.retentionYears) ||
      value.retentionYears < RETENTION_YEARS_MIN ||
      value.retentionYears > RETENTION_YEARS_MAX
    )
  ) {
    return error(
      'BAD_REQUEST',
      `대화 보존 기간은 ${RETENTION_YEARS_MIN}년 이상 ${RETENTION_YEARS_MAX}년 이하여야 합니다.`,
    )
  }

  return value as OfficeSettingsPatch
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLE_SET.has(value)
}

function isMemberStatus(value: unknown): value is MemberStatus {
  return typeof value === 'string' && MEMBER_STATUS_SET.has(value)
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function validEmail(value: string): boolean {
  if (value.length === 0 || value.length > EMAIL_MAX_LENGTH) {
    return false
  }

  const separator = value.indexOf('@')
  if (
    separator <= 0 ||
    separator !== value.lastIndexOf('@') ||
    separator > EMAIL_LOCAL_MAX_LENGTH
  ) {
    return false
  }

  const local = value.slice(0, separator)
  if (
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  ) {
    return false
  }

  return EMAIL_PATTERN.test(value)
}

async function readInvite(
  request: Request,
): Promise<OfficeInviteRequest | Response> {
  const value = await readJsonObject(request)
  if (value instanceof Response) return value

  if (
    !hasExactKeys(value, INVITE_KEYS) ||
    typeof value.email !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.title !== 'string' ||
    !isRole(value.role)
  ) {
    return error('BAD_REQUEST', '초대 정보가 올바르지 않습니다.')
  }

  const email = canonicalizeEmail(value.email)
  if (!validEmail(email)) {
    return error('BAD_REQUEST', '올바른 이메일을 입력해 주세요.')
  }

  const title = nonEmptyText(value.title)
  if (!title) {
    return error('BAD_REQUEST', '직함을 입력해 주세요.')
  }

  const name =
    value.name.trim() || email.slice(0, email.indexOf('@'))
  return { email, name, title, role: value.role }
}

async function readMemberPatch(
  request: Request,
): Promise<OfficeMemberPatch | Response> {
  const value = await readJsonObject(request)
  if (value instanceof Response) return value

  if (!hasOnlyKeys(value, MEMBER_PATCH_KEYS)) {
    return error('BAD_REQUEST', '변경할 직원 정보가 필요합니다.')
  }

  const name = nonEmptyText(value.name)
  const title = nonEmptyText(value.title)
  if (
    Object.hasOwn(value, 'name') &&
    !name
  ) {
    return error('BAD_REQUEST', '이름을 입력해 주세요.')
  }

  if (
    Object.hasOwn(value, 'title') &&
    !title
  ) {
    return error('BAD_REQUEST', '직함을 입력해 주세요.')
  }

  if (
    Object.hasOwn(value, 'role') &&
    !isRole(value.role)
  ) {
    return error('BAD_REQUEST', '역할이 올바르지 않습니다.')
  }

  return {
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(isRole(value.role) ? { role: value.role } : {}),
  }
}

async function readMemberStatusPatch(
  request: Request,
): Promise<OfficeMemberStatusPatch | Response> {
  const value = await readJsonObject(request)
  if (value instanceof Response) return value

  if (
    !hasExactKeys(value, MEMBER_STATUS_KEYS) ||
    !isMemberStatus(value.status)
  ) {
    return error('BAD_REQUEST', '직원 상태가 올바르지 않습니다.')
  }

  return { status: value.status }
}

function settingsFromRow(row: OfficeSettingsRow): OfficeSettings {
  return {
    exportLog: row.export_log === 1,
    retentionYears: row.retention_years,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

function memberFromRow(row: OfficeMemberRow): OfficeMember {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    title: row.title,
    role: row.role,
  }
}

function memberWithStatusFromRow(
  row: OfficeMemberRow,
): OfficeMemberWithStatus {
  return {
    ...memberFromRow(row),
    status: row.status,
  }
}

async function loadSettings(
  env: Env,
  session: SessionContext,
): Promise<OfficeSettingsRow | null> {
  const permission = actorPermissionGuard(
    session.userId,
    'office:manage',
    'settings_actor',
  )
  return env.DB.prepare(
    `SELECT
      settings.export_log,
      settings.retention_years,
      settings.updated_at,
      settings.updated_by
    FROM office_settings AS settings
    WHERE settings.office_id = ?
      AND ${permission.sql}`,
  )
    .bind(session.officeId, ...permission.bindings)
    .first<OfficeSettingsRow>()
}

async function loadMember(
  env: Env,
  officeId: string,
  memberId: string,
): Promise<OfficeMemberRow | null> {
  return env.DB.prepare(
    `SELECT id, email, name, title, role, status
    FROM users
    WHERE id = ?
      AND office_id = ?`,
  )
    .bind(memberId, officeId)
    .first<OfficeMemberRow>()
}

async function loadActorRole(
  env: Env,
  actorId: string,
): Promise<Role | null> {
  const row = await env.DB.prepare(
    `SELECT role
    FROM users
    WHERE id = ?
      AND status = ?`,
  )
    .bind(actorId, ACTIVE_STATUS)
    .first<{ role: Role }>()

  return row?.role ?? null
}

async function memberMutationFailure(
  env: Env,
  session: SessionContext,
  memberId: string,
  desiredRole?: Role,
  desiredStatus?: MemberStatus,
): Promise<Response | null> {
  const [actorRole, member] = await Promise.all([
    loadActorRole(env, session.userId),
    loadMember(env, session.officeId, memberId),
  ])
  if (
    !actorRole ||
    !hasPermission(actorRole, 'team:manage')
  ) {
    return error('FORBIDDEN', '직원을 관리할 수 없습니다.')
  }
  if (!member) {
    return error('NOT_FOUND', '직원을 찾을 수 없습니다.')
  }
  if (
    member.role === ADMIN_ROLE &&
    !hasPermission(actorRole, 'team:manage-administrator')
  ) {
    return error('FORBIDDEN', '관리자를 변경할 수 없습니다.')
  }
  if (
    desiredRole === ADMIN_ROLE &&
    !hasPermission(actorRole, 'team:assign-administrator')
  ) {
    return error('FORBIDDEN', '관리자 역할을 지정할 수 없습니다.')
  }
  if (
    memberId === session.userId &&
    desiredStatus === INACTIVE_STATUS
  ) {
    return error('CONFLICT', '자기 자신을 비활성화할 수 없습니다.')
  }

  return null
}

export function createOfficeRoutes(
  dependencies: OfficeDependencies = {},
): Route[] {
  const clock = dependencies.clock ?? Date.now
  const idFactory = dependencies.idFactory ?? createId

  async function getSettings(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session
    if (!hasPermission(session.role, 'office:manage')) {
      return error(
        'FORBIDDEN',
        '사무소 설정을 볼 수 없습니다.',
      )
    }

    const row = await loadSettings(env, session)
    if (!row) {
      return error(
        'FORBIDDEN',
        '사무소 설정을 볼 수 없습니다.',
      )
    }

    return json({
      settings: settingsFromRow(row),
    } satisfies OfficeSettingsResponse)
  }

  async function updateSettings(
    request: Request,
    env: Env,
    _params: Readonly<Record<string, string>>,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session
    if (!hasPermission(session.role, 'office:manage')) {
      return error(
        'FORBIDDEN',
        '사무소 설정을 변경할 수 없습니다.',
      )
    }

    const patch = await readSettingsPatch(request)
    if (patch instanceof Response) return patch

    const exportLog =
      patch.exportLog === undefined ? null : Number(patch.exportLog)
    const retentionYears = patch.retentionYears ?? null
    const now = clock()
    const payload: Record<string, boolean | number> = {}
    if (patch.exportLog !== undefined) {
      payload.exportLog = patch.exportLog
    }
    if (patch.retentionYears !== undefined) {
      payload.retentionYears = patch.retentionYears
    }
    const permission = actorPermissionGuard(
      session.userId,
      'office:manage',
      'settings_actor',
    )

    const publication = publish(
      env.DB,
      {
        officeId: session.officeId,
        type: SETTINGS_UPDATED_EVENT,
        entity: SETTINGS_ENTITY,
        entityId: session.officeId,
        actorKind: 'user',
        actorId: session.userId,
        payload,
        createdAt: now,
      },
      {
        // 직전 UPDATE가 실제로 바꾼 경우에만 이벤트를 기록한다.
        query: 'SELECT 1 WHERE changes() = 1',
      },
    )
    const statements = [
      env.DB.prepare(
        `UPDATE office_settings
        SET
          export_log = COALESCE(?, export_log),
          retention_years = COALESCE(?, retention_years),
          updated_at = ?,
          updated_by = ?
        WHERE office_id = ?
          AND (
            (? IS NOT NULL AND export_log <> ?)
            OR (? IS NOT NULL AND retention_years <> ?)
          )
          AND ${permission.sql}`,
      ).bind(
        exportLog,
        retentionYears,
        now,
        session.userId,
        session.officeId,
        exportLog,
        exportLog,
        retentionYears,
        retentionYears,
        ...permission.bindings,
      ),
      ...publication,
      permissionAuthorizationProbe(
        env.DB,
        session.userId,
        'office:manage',
      ),
    ]
    const [updateResult, , , authorizationResult] =
      await executeBatchAndBroadcast(
        env.DB,
        statements,
        [publication],
        ctx,
        env,
      )

    if (
      changes(updateResult) === 0 &&
      changes(authorizationResult) === 0
    ) {
      return error(
        'FORBIDDEN',
        '사무소 설정을 변경할 수 없습니다.',
      )
    }

    const row = await loadSettings(env, session)
    if (!row) {
      return error(
        'INTERNAL_ERROR',
        '사무소 설정을 불러오지 못했습니다.',
      )
    }

    return json({
      settings: settingsFromRow(row),
    } satisfies OfficeSettingsResponse)
  }

  async function getMembers(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session
    if (!hasPermission(session.role, 'team:view')) {
      return error('FORBIDDEN', '직원 목록을 볼 수 없습니다.')
    }

    const viewRoles = PERMISSION_ROLES['team:view']
    const manageRoles = PERMISSION_ROLES['team:manage']
    const { results } = await env.DB.prepare(
      `SELECT
        member.id,
        member.email,
        member.name,
        member.title,
        member.role,
        member.status,
        actor.role IN (${placeholders(manageRoles)}) AS can_manage
      FROM users AS member
      INNER JOIN users AS actor
        ON actor.id = ?
        AND actor.status = ?
        AND actor.role IN (${placeholders(viewRoles)})
      WHERE member.office_id = ?
        AND (
          member.status = ?
          OR actor.role IN (${placeholders(manageRoles)})
        )
      ORDER BY member.name, member.id`,
    )
      .bind(
        ...manageRoles,
        session.userId,
        ACTIVE_STATUS,
        ...viewRoles,
        session.officeId,
        ACTIVE_STATUS,
        ...manageRoles,
      )
      .all<ListedOfficeMemberRow>()

    if (results.length === 0) {
      return error('FORBIDDEN', '직원 목록을 볼 수 없습니다.')
    }

    return json({
      members: results.map((row) =>
        row.can_manage === 1
          ? memberWithStatusFromRow(row)
          : memberFromRow(row),
      ),
    } satisfies OfficeMembersResponse)
  }

  async function inviteMember(
    request: Request,
    env: Env,
    _params: Readonly<Record<string, string>>,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session
    if (!hasPermission(session.role, 'team:manage')) {
      return error('FORBIDDEN', '직원을 초대할 수 없습니다.')
    }

    const invite = await readInvite(request)
    if (invite instanceof Response) return invite
    if (
      invite.role === ADMIN_ROLE &&
      !hasPermission(
        session.role,
        'team:assign-administrator',
      )
    ) {
      return error(
        'FORBIDDEN',
        '관리자 역할을 지정할 수 없습니다.',
      )
    }

    const memberId = idFactory()
    const now = clock()
    const managePermission = actorPermissionGuard(
      session.userId,
      'team:manage',
      'invite_actor',
    )
    const assignPermission = actorPermissionGuard(
      session.userId,
      'team:assign-administrator',
      'invite_assigner',
    )
    const publication = publish(
      env.DB,
      {
        officeId: session.officeId,
        type: MEMBER_EVENT_TYPES.invited,
        entity: MEMBER_ENTITY,
        entityId: memberId,
        actorKind: 'user',
        actorId: session.userId,
        payload: {
          email: invite.email,
          name: invite.name,
          title: invite.title,
          role: invite.role,
          status: INVITED_STATUS,
        },
        createdAt: now,
      },
      {
        // 직전 INSERT가 새 초대 행을 만든 경우에만 이벤트를 기록한다.
        query: 'SELECT 1 WHERE changes() = 1',
      },
    )
    const authorizationPermission =
      invite.role === ADMIN_ROLE
        ? 'team:assign-administrator'
        : 'team:manage'
    const statements = [
      env.DB.prepare(
        `INSERT INTO users (
          id,
          office_id,
          email,
          name,
          title,
          role,
          status,
          created_at,
          updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${managePermission.sql}
          AND (
            ? <> ?
            OR ${assignPermission.sql}
          )
        ON CONFLICT(email) DO NOTHING`,
      ).bind(
        memberId,
        session.officeId,
        invite.email,
        invite.name,
        invite.title,
        invite.role,
        INVITED_STATUS,
        now,
        now,
        ...managePermission.bindings,
        invite.role,
        ADMIN_ROLE,
        ...assignPermission.bindings,
      ),
      ...publication,
      permissionAuthorizationProbe(
        env.DB,
        session.userId,
        authorizationPermission,
      ),
    ]
    const [result, , , authorizationResult] =
      await executeBatchAndBroadcast(
        env.DB,
        statements,
        [publication],
        ctx,
        env,
      )
    if (
      changes(result) === 0 &&
      changes(authorizationResult) === 0
    ) {
      return error('FORBIDDEN', '직원을 초대할 수 없습니다.')
    }

    const row = await env.DB.prepare(
      `SELECT id, email, name, title, role, status
      FROM users
      WHERE office_id = ?
        AND email = ?`,
    )
      .bind(session.officeId, invite.email)
      .first<OfficeMemberRow>()
    if (!row) {
      return error(
        'INTERNAL_ERROR',
        '초대된 직원을 불러오지 못했습니다.',
      )
    }

    return json(
      {
        member: memberWithStatusFromRow(row),
      } satisfies OfficeInviteResponse,
      { status: row.id === memberId ? 201 : 200 },
    )
  }

  async function updateMember(
    request: Request,
    env: Env,
    params: Readonly<Record<string, string>>,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session
    if (!hasPermission(session.role, 'team:manage')) {
      return error('FORBIDDEN', '직원을 관리할 수 없습니다.')
    }

    const patch = await readMemberPatch(request)
    if (patch instanceof Response) return patch

    const memberId = params.memberId
    const hasName = Number(patch.name !== undefined)
    const hasTitle = Number(patch.title !== undefined)
    const hasRole = Number(patch.role !== undefined)
    const name = patch.name ?? ''
    const title = patch.title ?? ''
    const role = patch.role ?? ADMIN_ROLE
    const now = clock()
    const differencePredicate = `(
      (? = 1 AND name <> ?)
      OR (? = 1 AND title <> ?)
      OR (? = 1 AND role <> ?)
    )`
    const differenceBindings = [
      hasName,
      name,
      hasTitle,
      title,
      hasRole,
      role,
    ] as const
    const managePermission = actorPermissionGuard(
      session.userId,
      'team:manage',
      'member_manager',
    )
    const manageAdminPermission = actorPermissionGuard(
      session.userId,
      'team:manage-administrator',
      'administrator_manager',
    )
    const assignAdminPermission = actorPermissionGuard(
      session.userId,
      'team:assign-administrator',
      'administrator_assigner',
    )
    const publication = publish(
      env.DB,
      {
        officeId: session.officeId,
        type: MEMBER_EVENT_TYPES.updated,
        entity: MEMBER_ENTITY,
        entityId: memberId,
        actorKind: 'user',
        actorId: session.userId,
        payload: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.title === undefined
            ? {}
            : { title: patch.title }),
          ...(patch.role === undefined ? {} : { role: patch.role }),
        },
        createdAt: now,
      },
      {
        // 직전 UPDATE가 실제 변경한 경우에만 이벤트를 기록한다.
        query: 'SELECT 1 WHERE changes() = 1',
      },
    )
    const statements = [
      env.DB.prepare(
        `UPDATE users AS member
        SET
          name = CASE WHEN ? = 1 THEN ? ELSE name END,
          title = CASE WHEN ? = 1 THEN ? ELSE title END,
          role = CASE WHEN ? = 1 THEN ? ELSE role END,
          updated_at = ?
        WHERE id = ?
          AND office_id = ?
          AND ${differencePredicate}
          AND ${managePermission.sql}
          AND (
            role <> ?
            OR ${manageAdminPermission.sql}
          )
          AND (
            ? = 0
            OR ? <> ?
            OR ${assignAdminPermission.sql}
          )
          AND (
            role <> ?
            OR status <> ?
            OR ? = 0
            OR ? = ?
            OR EXISTS (
              SELECT 1
              FROM users AS other_administrator
              WHERE other_administrator.id <> member.id
                AND other_administrator.role = ?
                AND other_administrator.status = ?
            )
          )`,
      ).bind(
        hasName,
        name,
        hasTitle,
        title,
        hasRole,
        role,
        now,
        memberId,
        session.officeId,
        ...differenceBindings,
        ...managePermission.bindings,
        ADMIN_ROLE,
        ...manageAdminPermission.bindings,
        hasRole,
        role,
        ADMIN_ROLE,
        ...assignAdminPermission.bindings,
        ADMIN_ROLE,
        ACTIVE_STATUS,
        hasRole,
        role,
        ADMIN_ROLE,
        ADMIN_ROLE,
        ACTIVE_STATUS,
      ),
      ...publication,
      permissionAuthorizationProbe(
        env.DB,
        session.userId,
        'team:manage',
      ),
    ]
    const [updateResult] = await executeBatchAndBroadcast(
      env.DB,
      statements,
      [publication],
      ctx,
      env,
    )

    if (changes(updateResult) === 0) {
      const failure = await memberMutationFailure(
        env,
        session,
        memberId,
        patch.role,
      )
      if (failure) return failure

      const unchanged = await loadMember(
        env,
        session.officeId,
        memberId,
      )
      if (
        !unchanged ||
        (patch.name !== undefined &&
          unchanged.name !== patch.name) ||
        (patch.title !== undefined &&
          unchanged.title !== patch.title) ||
        (patch.role !== undefined &&
          unchanged.role !== patch.role)
      ) {
        return error(
          'CONFLICT',
          '마지막 활성 관리자는 변경할 수 없습니다.',
        )
      }
    }

    const row = await loadMember(env, session.officeId, memberId)
    if (!row) {
      return error('NOT_FOUND', '직원을 찾을 수 없습니다.')
    }

    return json({
      member: memberWithStatusFromRow(row),
    } satisfies OfficeMemberResponse)
  }

  async function updateMemberStatus(
    request: Request,
    env: Env,
    params: Readonly<Record<string, string>>,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const session = await requireSession(request, env)
    if (session instanceof Response) return session
    if (!hasPermission(session.role, 'team:manage')) {
      return error('FORBIDDEN', '직원을 관리할 수 없습니다.')
    }

    const patch = await readMemberStatusPatch(request)
    if (patch instanceof Response) return patch

    const memberId = params.memberId
    const now = clock()
    const managePermission = actorPermissionGuard(
      session.userId,
      'team:manage',
      'status_manager',
    )
    const manageAdminPermission = actorPermissionGuard(
      session.userId,
      'team:manage-administrator',
      'status_administrator_manager',
    )
    const statusMutationGuard = `member.id = ?
      AND member.office_id = ?
      AND member.status <> ?
      AND ${managePermission.sql}
      AND (
        member.role <> ?
        OR ${manageAdminPermission.sql}
      )
      AND NOT (
        member.id = ?
        AND ? = ?
      )
      AND (
        member.role <> ?
        OR member.status <> ?
        OR ? <> ?
        OR EXISTS (
          SELECT 1
          FROM users AS other_administrator
          WHERE other_administrator.id <> member.id
            AND other_administrator.role = ?
            AND other_administrator.status = ?
        )
      )`
    const statusMutationBindings = [
      memberId,
      session.officeId,
      patch.status,
      ...managePermission.bindings,
      ADMIN_ROLE,
      ...manageAdminPermission.bindings,
      session.userId,
      patch.status,
      INACTIVE_STATUS,
      ADMIN_ROLE,
      ACTIVE_STATUS,
      patch.status,
      INACTIVE_STATUS,
      ADMIN_ROLE,
      ACTIVE_STATUS,
    ] as const
    const publication = publish(
      env.DB,
      {
        officeId: session.officeId,
        type: MEMBER_EVENT_TYPES.statusChanged,
        entity: MEMBER_ENTITY,
        entityId: memberId,
        actorKind: 'user',
        actorId: session.userId,
        payload: { status: patch.status },
        createdAt: now,
      },
      {
        // 직전 UPDATE가 실제 변경한 경우에만 이벤트를 기록한다.
        query: 'SELECT 1 WHERE changes() = 1',
      },
    )
    const statements = [
      // 담당 배정은 현재 응대 라우팅이므로 비활성 전이에 함께 제거한다.
      env.DB.prepare(
        `DELETE FROM conversation_assignees
        WHERE user_id = ?
          AND ? = ?
          AND EXISTS (
            SELECT 1
            FROM users AS member
            WHERE ${statusMutationGuard}
          )`,
      ).bind(
        memberId,
        patch.status,
        INACTIVE_STATUS,
        ...statusMutationBindings,
      ),
      // 재활성화가 퇴사 시점의 쿠키까지 되살리지 않도록 세션을 폐기한다.
      env.DB.prepare(
        `DELETE FROM auth_sessions
        WHERE user_id = ?
          AND ? = ?
          AND EXISTS (
            SELECT 1
            FROM users AS member
            WHERE ${statusMutationGuard}
          )`,
      ).bind(
        memberId,
        patch.status,
        INACTIVE_STATUS,
        ...statusMutationBindings,
      ),
      env.DB.prepare(
        `UPDATE users AS member
        SET status = ?,
          updated_at = ?
        WHERE ${statusMutationGuard}`,
      ).bind(
        patch.status,
        now,
        ...statusMutationBindings,
      ),
      ...publication,
      permissionAuthorizationProbe(
        env.DB,
        session.userId,
        'team:manage',
      ),
    ]
    const [, , updateResult] = await executeBatchAndBroadcast(
      env.DB,
      statements,
      [publication],
      ctx,
      env,
    )

    if (changes(updateResult) === 0) {
      const failure = await memberMutationFailure(
        env,
        session,
        memberId,
        undefined,
        patch.status,
      )
      if (failure) return failure

      const unchanged = await loadMember(
        env,
        session.officeId,
        memberId,
      )
      if (!unchanged || unchanged.status !== patch.status) {
        return error(
          'CONFLICT',
          '마지막 활성 관리자는 비활성화할 수 없습니다.',
        )
      }
    }

    const row = await loadMember(env, session.officeId, memberId)
    if (!row) {
      return error('NOT_FOUND', '직원을 찾을 수 없습니다.')
    }

    return json({
      member: memberWithStatusFromRow(row),
    } satisfies OfficeMemberResponse)
  }

  return [
    {
      method: 'GET',
      path: '/api/office/settings',
      handler: getSettings,
    },
    {
      method: 'PATCH',
      path: '/api/office/settings',
      handler: updateSettings,
    },
    {
      method: 'GET',
      path: '/api/office/members',
      handler: getMembers,
    },
    {
      method: 'POST',
      path: '/api/office/invites',
      handler: inviteMember,
    },
    {
      method: 'PATCH',
      path: '/api/office/members/:memberId',
      handler: updateMember,
    },
    {
      method: 'PATCH',
      path: '/api/office/members/:memberId/status',
      handler: updateMemberStatus,
    },
  ]
}

export const routes = createOfficeRoutes()
