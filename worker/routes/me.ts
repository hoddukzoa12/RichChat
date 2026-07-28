import type { Role } from '../../shared/domain'
import { changes } from '../db/d1'
import { error } from '../http/error'
import type { Route } from '../http/router'
import {
  requireSession,
  type SessionContext,
} from '../http/session'
import { json } from '../http/respond'

export const DEFAULT_USER_SETTINGS = {
  notifyNewChat: true,
  notifyMineOnly: false,
  notifySound: true,
} as const

const PROFILE_KEYS = ['name', 'title'] as const
const SETTING_KEYS = [
  'notifyNewChat',
  'notifyMineOnly',
  'notifySound',
] as const

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
    isAdmin: row.role === '관리자',
  })
}

async function getMe(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  return meResponse(env, session)
}

async function patchMe(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  if (
    !hasOnlyKeys(body, PROFILE_KEYS) ||
    Object.keys(body).length === 0
  ) {
    return error(
      'BAD_REQUEST',
      '이름과 직함만 변경할 수 있습니다.',
    )
  }

  const name = body.name
  const title = body.title
  if (
    (name !== undefined &&
      (typeof name !== 'string' || name.trim() === '')) ||
    (title !== undefined &&
      (typeof title !== 'string' || title.trim() === ''))
  ) {
    return error('BAD_REQUEST', '이름과 직함은 빈 문자열일 수 없습니다.')
  }

  const result = await env.DB.prepare(
    `UPDATE users
    SET
      name = COALESCE(?, name),
      title = COALESCE(?, title),
      updated_at = ?
    WHERE id = ?
      AND office_id = ?`,
  )
    .bind(
      typeof name === 'string' ? name.trim() : null,
      typeof title === 'string' ? title.trim() : null,
      Date.now(),
      session.userId,
      session.officeId,
    )
    .run()

  if (changes(result) !== 1) {
    return error('UNAUTHORIZED', '로그인이 필요합니다.')
  }

  return meResponse(env, session)
}

async function patchSettings(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env)
  if (session instanceof Response) return session

  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  if (
    !hasOnlyKeys(body, SETTING_KEYS) ||
    Object.keys(body).length === 0
  ) {
    return error('BAD_REQUEST', '알림 설정 값이 필요합니다.')
  }

  for (const key of SETTING_KEYS) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      return error('BAD_REQUEST', '알림 설정은 참 또는 거짓이어야 합니다.')
    }
  }

  const notifyNewChat =
    typeof body.notifyNewChat === 'boolean'
      ? Number(body.notifyNewChat)
      : null
  const notifyMineOnly =
    typeof body.notifyMineOnly === 'boolean'
      ? Number(body.notifyMineOnly)
      : null
  const notifySound =
    typeof body.notifySound === 'boolean'
      ? Number(body.notifySound)
      : null
  const now = Date.now()

  await env.DB.prepare(
    `INSERT INTO user_settings (
      user_id,
      notify_new_chat,
      notify_mine_only,
      notify_sound,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      notify_new_chat = COALESCE(?, user_settings.notify_new_chat),
      notify_mine_only = COALESCE(?, user_settings.notify_mine_only),
      notify_sound = COALESCE(?, user_settings.notify_sound),
      updated_at = excluded.updated_at`,
  )
    .bind(
      session.userId,
      notifyNewChat ?? Number(DEFAULT_USER_SETTINGS.notifyNewChat),
      notifyMineOnly ?? Number(DEFAULT_USER_SETTINGS.notifyMineOnly),
      notifySound ?? Number(DEFAULT_USER_SETTINGS.notifySound),
      now,
      notifyNewChat,
      notifyMineOnly,
      notifySound,
    )
    .run()

  return meResponse(env, session)
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/me',
    handler: getMe,
  },
  {
    method: 'PATCH',
    path: '/api/me',
    handler: patchMe,
  },
  {
    method: 'PATCH',
    path: '/api/me/settings',
    handler: patchSettings,
  },
]
