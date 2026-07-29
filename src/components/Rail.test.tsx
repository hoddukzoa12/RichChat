import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Role } from '../../shared/domain'
import { permissionsForRole } from '../../shared/permissions'
import type { MeResponse } from '../../shared/wire/settings'
import { Rail } from './Rail'

let role: Role = '관리자'

function meForRole(currentRole: Role): MeResponse {
  return {
    user: {
      id: 'user-1',
      name: '김리치',
      title: '세무사',
      email: 'kim@rich.kr',
      role: currentRole,
    },
    office: {
      id: 'office-1',
      name: '세무법인 리치',
      emailDomain: 'rich.kr',
    },
    settings: {
      notifyNewChat: true,
      notifyMineOnly: false,
      notifySound: true,
    },
    permissions: permissionsForRole(currentRole),
  }
}

vi.mock('../api/AuthGate', () => ({
  useAuth: () => ({ me: meForRole(role) }),
}))

vi.mock('../state/InboxContext', () => ({
  useInbox: () => ({
    state: {
      page: 'chat',
      facets: { status: { 미처리: 2 } },
    },
    dispatch: vi.fn(),
  }),
}))

describe('office rail access', () => {
  it.each([
    { label: 'administrator', role: '관리자' },
    { label: 'deputy manager', role: '부관리자' },
  ] as const)(
    'shows the office entry to $label',
    ({ role: currentRole }) => {
      role = currentRole

      expect(renderToStaticMarkup(<Rail />)).toContain('사무소')
    },
  )

  it.each([
    { label: 'tax accountant', role: '세무사' },
    { label: 'counselor', role: '상담 담당' },
  ] as const)(
    'hides the office entry from $label',
    ({ role: currentRole }) => {
      role = currentRole

      expect(renderToStaticMarkup(<Rail />)).not.toContain('사무소')
    },
  )
})
