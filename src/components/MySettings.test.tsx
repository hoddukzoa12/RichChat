import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { permissionsForRole } from '../../shared/permissions'
import type { MeResponse } from '../../shared/wire/settings'
import { MySettings } from './MySettings'

const ME: MeResponse = {
  user: {
    id: 'user-1',
    name: '김리치',
    title: '세무사',
    email: 'kim@rich.kr',
    role: '세무사',
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
  permissions: permissionsForRole('세무사'),
}

vi.mock('../api/AuthGate', () => ({
  useAuth: () => ({
    me: ME,
    applyMeResponse: vi.fn(),
    completeLogout: vi.fn(),
  }),
}))

vi.mock('../state/InboxContext', () => ({
  useInbox: () => ({
    state: {
      ai: {
        summary: true,
        autofill: true,
        draft: false,
      },
    },
    dispatch: vi.fn(),
  }),
}))

describe('personal profile presentation', () => {
  it('explains where the read-only title is managed', () => {
    const markup = renderToStaticMarkup(<MySettings />)

    expect(markup).toContain(
      '직함은 사무소의 직원 관리 화면에서 변경할 수 있습니다.',
    )
  })
})
