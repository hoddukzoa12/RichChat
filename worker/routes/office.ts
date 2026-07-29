import {
  USER_STATUSES,
  type Role,
  type UserStatus,
} from '../../shared/domain'
import { canonicalizeEmail } from '../../shared/email'
import {
  INVITE_ROLES,
  RETENTION_YEARS_MAX,
  RETENTION_YEARS_MIN,
  type InviteRole,
  type OfficeInviteRequest,
  type OfficeInviteResponse,
  type OfficeMember,
  type OfficeMembersResponse,
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

type JsonObject = Record<string, unknown>

const SETTINGS_PATCH_KEYS = new Set([
  'exportLog',
  'retentionYears',
])
const INVITE_KEYS = new Set(['email', 'role'])
const INVITE_ROLE_SET = new Set<string>(INVITE_ROLES)
const EMAIL_MAX_LENGTH = 254
const EMAIL_LOCAL_MAX_LENGTH = 64
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const ADMIN_ROLE = '관리자' satisfies Role
const [INVITED_STATUS, ACTIVE_STATUS] = USER_STATUSES
const ADMIN_EXISTS_SQL = `SELECT 1
                          FROM users AS administrator
                          WHERE administrator.id = ?
                            AND administrator.role = ?`
const SETTINGS_ENTITY = 'office_settings'
const SETTINGS_UPDATED_EVENT = 'office.settings.updated'
const MEMBER_ENTITY = 'user'
const MEMBER_INVITED_EVENT = 'office.member.invited'

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

async function readSettingsPatch(
  request: Request,
): Promise<OfficeSettingsPatch | Response> {
  const value = await readJsonObject(request)
  if (value instanceof Response) return value

  const keys = Object.keys(value)
  if (
    keys.length === 0 ||
    keys.some((key) => !SETTINGS_PATCH_KEYS.has(key))
  ) {
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

function isInviteRole(value: unknown): value is InviteRole {
  return typeof value === 'string' && INVITE_ROLE_SET.has(value)
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

  const keys = Object.keys(value)
  if (
    keys.length !== INVITE_KEYS.size ||
    keys.some((key) => !INVITE_KEYS.has(key)) ||
    typeof value.email !== 'string' ||
    !isInviteRole(value.role)
  ) {
    return error('BAD_REQUEST', '초대 정보가 올바르지 않습니다.')
  }

  const email = canonicalizeEmail(value.email)
  if (!validEmail(email)) {
    return error('BAD_REQUEST', '올바른 이메일을 입력해 주세요.')
  }

  return { email, role: value.role }
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

const MEMBER_MAPPERS: Record<
  Role,
  (row: OfficeMemberRow) => OfficeMember | OfficeMemberWithStatus
> = {
  관리자: memberWithStatusFromRow,
  부관리자: memberFromRow,
  세무사: memberFromRow,
  '상담 담당': memberFromRow,
}

function adminAuthorizationProbe(
  db: D1Database,
  userId: string,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE users
    SET role = role
    WHERE id = ?
      AND role = ?`,
  ).bind(userId, ADMIN_ROLE)
}

async function loadAdminSettings(
  env: Env,
  session: SessionContext,
): Promise<OfficeSettingsRow | null> {
  return env.DB.prepare(
    `SELECT
      settings.export_log,
      settings.retention_years,
      settings.updated_at,
      settings.updated_by
    FROM office_settings AS settings
    WHERE settings.office_id = ?
      AND EXISTS (${ADMIN_EXISTS_SQL})`,
  )
    .bind(session.officeId, session.userId, ADMIN_ROLE)
    .first<OfficeSettingsRow>()
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

    const row = await loadAdminSettings(env, session)
    if (!row) {
      return error('FORBIDDEN', '사무소 설정을 볼 수 없습니다.')
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
        // 직전 UPDATE가 실제로 바꾼 경우에만 이어지는 두 이벤트 문장이 실행된다.
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
          AND EXISTS (${ADMIN_EXISTS_SQL})`,
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
        session.userId,
        ADMIN_ROLE,
      ),
      ...publication,
      adminAuthorizationProbe(env.DB, session.userId),
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

    const row = await loadAdminSettings(env, session)
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

    const { results } = await env.DB.prepare(
      `SELECT id, email, name, title, role, status
      FROM users
      WHERE office_id = ?
        AND (
          status = ?
          OR EXISTS (${ADMIN_EXISTS_SQL})
        )
      ORDER BY name, id`,
    )
      .bind(
        session.officeId,
        ACTIVE_STATUS,
        session.userId,
        ADMIN_ROLE,
      )
      .all<OfficeMemberRow>()

    return json({
      members: results.map(MEMBER_MAPPERS[session.role]),
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

    const invite = await readInvite(request)
    if (invite instanceof Response) return invite

    const memberId = idFactory()
    const now = clock()
    const publication = publish(
      env.DB,
      {
        officeId: session.officeId,
        type: MEMBER_INVITED_EVENT,
        entity: MEMBER_ENTITY,
        entityId: memberId,
        actorKind: 'user',
        actorId: session.userId,
        payload: {
          email: invite.email,
          role: invite.role,
          status: INVITED_STATUS,
        },
        createdAt: now,
      },
      {
        query: `SELECT 1
                FROM users
                WHERE id = ?
                  AND office_id = ?`,
        bindings: [memberId, session.officeId],
      },
    )
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
        WHERE EXISTS (${ADMIN_EXISTS_SQL})
        ON CONFLICT(email) DO NOTHING`,
      ).bind(
        memberId,
        session.officeId,
        invite.email,
        invite.email,
        invite.role,
        invite.role,
        INVITED_STATUS,
        now,
        now,
        session.userId,
        ADMIN_ROLE,
      ),
      ...publication,
      adminAuthorizationProbe(env.DB, session.userId),
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
  ]
}

export const routes = createOfficeRoutes()
