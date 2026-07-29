import type { Role } from '../../shared/domain'
import { permissionsForRole } from '../../shared/permissions'
import {
  DEFAULT_USER_SETTINGS,
  ME_PROFILE_FIELDS,
  USER_SETTING_FIELDS,
  USER_SETTING_INPUTS,
  type MeResponse,
  type UserSettingInput,
  type UserSettings,
} from '../../shared/wire/settings'
import { publish } from '../db/events'
import { error } from '../http/error'
import type { Route } from '../http/router'
import {
  requireSession,
  type SessionContext,
} from '../http/session'
import { json } from '../http/respond'
import type { Clock } from '../lib/ids'
import { executeBatchAndBroadcast } from '../realtime/broadcast'

export { DEFAULT_USER_SETTINGS } from '../../shared/wire/settings'

export const USER_EVENT_ENTITY = 'user'
type UserEventAction = 'profileUpdated' | 'settingsUpdated'
export const USER_EVENT_TYPES = {
  profileUpdated: 'user.profile.updated',
  settingsUpdated: 'user.settings.updated',
} as const satisfies Record<UserEventAction, string>
const SETTING_INPUT_VALUES = new Map<unknown, 0 | 1>(
  USER_SETTING_INPUTS,
)
const DB_BOOLEAN_VALUES: Record<0 | 1, boolean> = {
  0: false,
  1: true,
}

function settingInput(value: UserSettingInput): 0 | 1 {
  const normalized = SETTING_INPUT_VALUES.get(value)
  if (normalized === undefined) {
    throw new TypeError('기본 알림 설정을 정규화할 수 없습니다.')
  }

  return normalized
}

const DEFAULT_USER_SETTINGS_DB: Record<keyof UserSettings, 0 | 1> = {
  notifyNewChat: settingInput(DEFAULT_USER_SETTINGS.notifyNewChat),
  notifyMineOnly: settingInput(DEFAULT_USER_SETTINGS.notifyMineOnly),
  notifySound: settingInput(DEFAULT_USER_SETTINGS.notifySound),
}

interface MeRow {
  user_id: string
  name: string
  title: string
  email: string
  role: Role
  office_id: string
  office_name: string
  email_domain: string | null
  notify_new_chat: number | null
  notify_mine_only: number | null
  notify_sound: number | null
}

type JsonObject = Record<string, unknown>

interface ProfilePatch {
  name: string
}

interface SettingsPatch {
  notifyNewChat?: 0 | 1
  notifyMineOnly?: 0 | 1
  notifySound?: 0 | 1
}

interface MeRouteDependencies {
  clock?: Clock
}

async function readJsonObject(
  request: Request,
): Promise<JsonObject | Response> {
  try {
    const value: unknown = await request.json()
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      return error('BAD_REQUEST', 'JSON 객체가 필요합니다.')
    }

    return value as JsonObject
  } catch {
    return error('BAD_REQUEST', '올바른 JSON 본문이 필요합니다.')
  }
}

function hasOnlyKeys(
  object: JsonObject,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys)
  return Object.keys(object).every((key) => allowed.has(key))
}

function parseProfilePatch(
  body: JsonObject,
): ProfilePatch | Response {
  if (
    !hasOnlyKeys(body, ME_PROFILE_FIELDS) ||
    !ME_PROFILE_FIELDS.some((key) => Object.hasOwn(body, key))
  ) {
    return error('BAD_REQUEST', '이름만 변경할 수 있습니다.')
  }

  if (
    typeof body.name !== 'string' ||
    body.name.trim() === ''
  ) {
    return error('BAD_REQUEST', '이름은 빈 문자열일 수 없습니다.')
  }

  return {
    name: body.name.trim(),
  }
}

function parseSettingsPatch(
  body: JsonObject,
): SettingsPatch | Response {
  if (
    !hasOnlyKeys(body, USER_SETTING_FIELDS) ||
    !USER_SETTING_FIELDS.some((key) => Object.hasOwn(body, key))
  ) {
    return error('BAD_REQUEST', '알림 설정 값이 필요합니다.')
  }

  const patch: SettingsPatch = {}
  for (const key of USER_SETTING_FIELDS) {
    if (!Object.hasOwn(body, key)) continue

    const normalized = SETTING_INPUT_VALUES.get(body[key])
    if (normalized === undefined) {
      return error(
        'BAD_REQUEST',
        '알림 설정은 참 또는 거짓이어야 합니다.',
      )
    }
    patch[key] = normalized
  }

  return patch
}

async function loadMe(
  env: Env,
  session: SessionContext,
): Promise<MeRow | null> {
  return env.DB.prepare(
    `SELECT
      users.id AS user_id,
      users.name,
      users.title,
      users.email,
      users.role,
      offices.id AS office_id,
      offices.name AS office_name,
      offices.email_domain,
      user_settings.notify_new_chat,
      user_settings.notify_mine_only,
      user_settings.notify_sound
    FROM users
    INNER JOIN offices ON offices.id = users.office_id
    LEFT JOIN user_settings ON user_settings.user_id = users.id
    WHERE users.id = ?
      AND users.office_id = ?`,
  )
    .bind(session.userId, session.officeId)
    .first<MeRow>()
}

function setting(value: number | null, fallback: boolean): boolean {
  return value === null ? fallback : value === 1
}

async function meResponse(
  env: Env,
  session: SessionContext,
): Promise<Response> {
  const row = await loadMe(env, session)
  if (!row) return error('UNAUTHORIZED', '로그인이 필요합니다.')

  return json({
    user: {
      id: row.user_id,
      name: row.name,
      title: row.title,
      email: row.email,
      role: row.role,
    },
    office: {
      id: row.office_id,
      name: row.office_name,
      emailDomain: row.email_domain,
    },
    settings: {
      notifyNewChat: setting(
        row.notify_new_chat,
        DEFAULT_USER_SETTINGS.notifyNewChat,
      ),
      notifyMineOnly: setting(
        row.notify_mine_only,
        DEFAULT_USER_SETTINGS.notifyMineOnly,
      ),
      notifySound: setting(
        row.notify_sound,
        DEFAULT_USER_SETTINGS.notifySound,
      ),
    },
    permissions: permissionsForRole(row.role),
  } satisfies MeResponse)
}

async function getMe(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  return meResponse(env, session)
}

async function patchMe(
  request: Request,
  env: Env,
  clock: Clock,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  const patch = parseProfilePatch(body)
  if (patch instanceof Response) return patch

  const now = clock()
  const differencePredicate = 'name <> ?'
  const differenceBindings = [patch.name] as const

  const publication = publish(
    env.DB,
    {
      officeId: session.officeId,
      type: USER_EVENT_TYPES.profileUpdated,
      entity: USER_EVENT_ENTITY,
      entityId: session.userId,
      actorKind: 'user',
      actorId: session.userId,
      payload: {
        name: patch.name,
      },
      createdAt: now,
    },
    {
      query: `SELECT 1
              FROM users
              WHERE id = ?
                AND office_id = ?
                AND ${differencePredicate}`,
      bindings: [
        session.userId,
        session.officeId,
        ...differenceBindings,
      ],
    },
  )
  const statements = [
    ...publication,
    env.DB.prepare(
      `UPDATE users
      SET name = ?,
        updated_at = ?
      WHERE id = ?
        AND office_id = ?
        AND ${differencePredicate}`,
    ).bind(
      patch.name,
      now,
      session.userId,
      session.officeId,
      ...differenceBindings,
    ),
  ]
  await executeBatchAndBroadcast(
    env.DB,
    statements,
    [publication],
    ctx,
    env,
  )

  return meResponse(env, session)
}

async function patchSettings(
  request: Request,
  env: Env,
  clock: Clock,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  const patch = parseSettingsPatch(body)
  if (patch instanceof Response) return patch

  const hasNotifyNewChat = Number(
    patch.notifyNewChat !== undefined,
  )
  const hasNotifyMineOnly = Number(
    patch.notifyMineOnly !== undefined,
  )
  const hasNotifySound = Number(patch.notifySound !== undefined)
  const notifyNewChat =
    patch.notifyNewChat ?? DEFAULT_USER_SETTINGS_DB.notifyNewChat
  const notifyMineOnly =
    patch.notifyMineOnly ?? DEFAULT_USER_SETTINGS_DB.notifyMineOnly
  const notifySound =
    patch.notifySound ?? DEFAULT_USER_SETTINGS_DB.notifySound
  const now = clock()
  const differencePredicate = `(
    (? = 1 AND notify_new_chat <> ?)
    OR (? = 1 AND notify_mine_only <> ?)
    OR (? = 1 AND notify_sound <> ?)
  )`
  const differenceBindings = [
    hasNotifyNewChat,
    notifyNewChat,
    hasNotifyMineOnly,
    notifyMineOnly,
    hasNotifySound,
    notifySound,
  ] as const
  const changeGuard = `SELECT 1
    FROM users
    WHERE users.id = ?
      AND users.office_id = ?
      AND (
        NOT EXISTS (
          SELECT 1
          FROM user_settings
          WHERE user_settings.user_id = users.id
        )
        OR EXISTS (
          SELECT 1
          FROM user_settings
          WHERE user_settings.user_id = users.id
            AND ${differencePredicate}
        )
      )`

  const publication = publish(
    env.DB,
    {
      officeId: session.officeId,
      type: USER_EVENT_TYPES.settingsUpdated,
      entity: USER_EVENT_ENTITY,
      entityId: session.userId,
      actorKind: 'user',
      actorId: session.userId,
      payload: {
        ...(patch.notifyNewChat === undefined
          ? {}
          : {
              notifyNewChat:
                DB_BOOLEAN_VALUES[patch.notifyNewChat],
            }),
        ...(patch.notifyMineOnly === undefined
          ? {}
          : {
              notifyMineOnly:
                DB_BOOLEAN_VALUES[patch.notifyMineOnly],
            }),
        ...(patch.notifySound === undefined
          ? {}
          : {
              notifySound: DB_BOOLEAN_VALUES[patch.notifySound],
            }),
      },
      createdAt: now,
    },
    {
      query: changeGuard,
      bindings: [
        session.userId,
        session.officeId,
        ...differenceBindings,
      ],
    },
  )
  const statements = [
    ...publication,
    env.DB.prepare(
      `INSERT INTO user_settings (
        user_id,
        notify_new_chat,
        notify_mine_only,
        notify_sound,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        notify_new_chat = CASE
          WHEN ? = 1 THEN ?
          ELSE user_settings.notify_new_chat
        END,
        notify_mine_only = CASE
          WHEN ? = 1 THEN ?
          ELSE user_settings.notify_mine_only
        END,
        notify_sound = CASE
          WHEN ? = 1 THEN ?
          ELSE user_settings.notify_sound
        END,
        updated_at = excluded.updated_at
      WHERE ${differencePredicate}`,
    ).bind(
      session.userId,
      notifyNewChat,
      notifyMineOnly,
      notifySound,
      now,
      ...differenceBindings,
      ...differenceBindings,
    ),
  ]
  await executeBatchAndBroadcast(
    env.DB,
    statements,
    [publication],
    ctx,
    env,
  )

  return meResponse(env, session)
}

export function createMeRoutes(
  dependencies: MeRouteDependencies = {},
): Route[] {
  const clock = dependencies.clock ?? Date.now

  return [
    {
      method: 'GET',
      path: '/api/me',
      handler: getMe,
    },
    {
      method: 'PATCH',
      path: '/api/me',
      handler: (request, env, _params, ctx) =>
        patchMe(request, env, clock, ctx),
    },
    {
      method: 'PATCH',
      path: '/api/me/settings',
      handler: (request, env, _params, ctx) =>
        patchSettings(request, env, clock, ctx),
    },
  ]
}

export const routes = createMeRoutes()
