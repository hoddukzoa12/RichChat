import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLES, type Role } from '../../shared/domain'
import {
  PERMISSIONS,
  permissionsForRole,
  type PermissionSet,
} from '../../shared/permissions'
import type { MeResponse } from '../../shared/wire/settings'
import { initialState, type InboxState } from '../state/inbox'
import { OfficeSettings } from './OfficeSettings'

function meForRole(role: Role): MeResponse {
  return {
    user: {
      id: 'member-manager',
      name: '이관리',
      title: '팀장',
      email: 'manager@rich.kr',
      role,
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
    permissions: permissionsForRole(role),
  }
}

let me = meForRole('관리자')
const BASE_INBOX_STATE: InboxState = {
  ...initialState,
  teamLoading: false,
  team: [
    {
      id: 'member-manager',
      email: 'manager@rich.kr',
      name: '이관리',
      title: '팀장',
      role: '관리자',
      status: '활성',
    },
    {
      id: 'member-inactive',
      email: 'inactive@rich.kr',
      name: '퇴사 직원',
      title: '대리',
      role: '상담 담당',
      status: '비활성',
    },
  ],
}
let inboxState = BASE_INBOX_STATE

vi.mock('../api/AuthGate', () => ({
  useAuth: () => ({ me }),
}))

vi.mock('../state/InboxContext', () => ({
  useInbox: () => ({ state: inboxState, dispatch: vi.fn() }),
}))

describe('office settings access and member presentation', () => {
  beforeEach(() => {
    me = meForRole('관리자')
    inboxState = {
      ...BASE_INBOX_STATE,
      team: [...BASE_INBOX_STATE.team],
    }
  })

  it('lets a deputy manager manage the team without office policies', () => {
    me = meForRole('부관리자')

    const markup = renderToStaticMarkup(<OfficeSettings />)

    expect(markup).toContain('직원 · 권한')
    expect(markup).toContain('＋ 초대')
    expect(markup).toContain('퇴사 직원')
    expect(markup).toContain('대리 · inactive@rich.kr')
    expect(markup).toContain('>비활성<')
    expect(markup).toContain('재활성화')
    expect(markup).not.toContain('문자 연동')
    expect(markup).not.toContain('AI · 데이터 정책')
  })

  it('shows office policies to an office manager', () => {
    me = meForRole('관리자')

    const markup = renderToStaticMarkup(<OfficeSettings />)

    expect(markup).toContain('문자 연동')
    expect(markup).toContain('AI · 데이터 정책')
  })

  it('offers every role with separate invite profile fields', () => {
    inboxState = { ...inboxState, inviteOpen: true }

    const markup = renderToStaticMarkup(<OfficeSettings />)

    expect(markup).toContain('직원 초대')
    expect(markup).toContain('이름')
    expect(markup).toContain('직함')
    expect(markup).toContain('이메일')
    for (const role of ROLES) expect(markup).toContain(`>${role}<`)
  })

  it('renders an explicit denial without team view permission', () => {
    const permissions = Object.fromEntries(
      PERMISSIONS.map((permission) => [permission, false]),
    ) as PermissionSet
    me = { ...meForRole('상담 담당'), permissions }

    const markup = renderToStaticMarkup(<OfficeSettings />)

    expect(markup).toContain('403')
    expect(markup).toContain(
      '이 계정에는 직원 목록을 볼 권한이 없습니다.',
    )
    expect(markup).not.toContain('직원 · 권한')
  })
})
