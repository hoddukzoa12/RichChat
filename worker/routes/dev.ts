import type { UserStatus } from '../../shared/domain'
import { executeBatch } from '../db/d1'
import { error } from '../http/error'
import type { Route } from '../http/router'
import {
  createSession,
  createSessionCookie,
  csrfFailure,
} from '../http/session'
import { json } from '../http/respond'
import { createId } from '../lib/ids'
import { DEFAULT_USER_SETTINGS } from './me'

const DEV_USER = {
  email: 'dev@rich.local',
  name: '개발 관리자',
  title: '관리자',
  role: '관리자',
} as const

const DEV_OFFICE_NAME = '세무법인 리치'

interface DevUserRow {
  id: string
  office_id: string
  status: UserStatus
}

function isDevelopment(env: Env): boolean {
  const enabled: string = env.DEV_LOGIN_ENABLED
  return enabled === 'true'
}

async function ensureDevUser(env: Env): Promise<DevUserRow | Response> {
  const existing = await env.DB.prepare(
    'SELECT id, office_id, status FROM users WHERE email = ?',
  )
    .bind(DEV_USER.email)
    .first<DevUserRow>()

  if (existing) {
    if (existing.status !== '활성') {
      return error('FORBIDDEN', '활성 상태인 직원만 로그인할 수 있습니다.')
    }

    await executeBatch(env.DB, [
      env.DB.prepare(
        `INSERT INTO user_settings (
          user_id,
          notify_new_chat,
          notify_mine_only,
          notify_sound,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO NOTHING`,
      ).bind(
        existing.id,
        Number(DEFAULT_USER_SETTINGS.notifyNewChat),
        Number(DEFAULT_USER_SETTINGS.notifyMineOnly),
        Number(DEFAULT_USER_SETTINGS.notifySound),
        Date.now(),
      ),
    ])

    return existing
  }

  const now = Date.now()
  const office = await env.DB.prepare(
    'SELECT id FROM offices ORDER BY created_at, id LIMIT 1',
  ).first<{ id: string }>()
  const officeId = office?.id ?? createId()
  const userId = createId()
  const statements: D1PreparedStatement[] = []

  if (!office) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
      ).bind(officeId, DEV_OFFICE_NAME, now),
    )
  }

  statements.push(
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
      ) VALUES (?, ?, ?, ?, ?, ?, '활성', ?, ?)`,
    ).bind(
      userId,
      officeId,
      DEV_USER.email,
      DEV_USER.name,
      DEV_USER.title,
      DEV_USER.role,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_settings (
        user_id,
        notify_new_chat,
        notify_mine_only,
        notify_sound,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      Number(DEFAULT_USER_SETTINGS.notifyNewChat),
      Number(DEFAULT_USER_SETTINGS.notifyMineOnly),
      Number(DEFAULT_USER_SETTINGS.notifySound),
      now,
    ),
  )

  await executeBatch(env.DB, statements)

  return {
    id: userId,
    office_id: officeId,
    status: '활성',
  }
}

async function devLogin(request: Request, env: Env): Promise<Response> {
  if (!isDevelopment(env)) {
    return error('NOT_FOUND', '요청한 API를 찾을 수 없습니다.')
  }

  const csrfError = csrfFailure(request)
  if (csrfError) return csrfError

  const user = await ensureDevUser(env)
  if (user instanceof Response) return user

  const session = await createSession(env.DB, {
    userId: user.id,
    officeId: user.office_id,
  })

  return json(
    {
      ok: true,
      expiresAt: session.expiresAt,
    },
    {
      headers: {
        'set-cookie': createSessionCookie(
          session.token,
          session.expiresAt,
        ),
      },
    },
  )
}

export const routes: Route[] = [
  {
    method: 'POST',
    path: '/api/dev/login',
    handler: devLogin,
  },
]
