import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { permissionsForRole } from '../../shared/permissions'
import type { MeResponse } from '../../shared/wire/settings'
import { MySettings } from './MySettings'

const mocks = vi.hoisted(() => ({
  applyMeResponse: vi.fn(),
  updateMeSettings: vi.fn(),
}))

const me: MeResponse = {
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
    me,
    applyMeResponse: mocks.applyMeResponse,
    completeLogout: vi.fn(),
  }),
}))

vi.mock('../api/endpoints', () => ({
  logout: vi.fn(),
  updateMe: vi.fn(),
  updateMeSettings: mocks.updateMeSettings,
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

class FakeNotification {
  static permission: NotificationPermission = 'denied'
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>()
}

function notificationButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.includes('새 대화 알림'),
  )
  if (!button) throw new Error('새 대화 알림 토글을 찾지 못했습니다.')
  return button
}

describe('Notification permission settings', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean
      }
    ).IS_REACT_ACT_ENVIRONMENT = true
    FakeNotification.permission = 'denied'
    FakeNotification.requestPermission.mockReset()
    mocks.applyMeResponse.mockReset()
    mocks.updateMeSettings.mockReset()
    vi.stubGlobal(
      'Notification',
      FakeNotification as unknown as typeof Notification,
    )
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('shows a blocked browser permission without an enabled toggle', () => {
    act(() => root.render(<MySettings />))

    expect(container.textContent).toContain('브라우저에서 차단됨')
    expect(notificationButton(container).disabled).toBe(true)
  })

  it('requests permission from the toggle click', async () => {
    FakeNotification.permission = 'default'
    FakeNotification.requestPermission.mockImplementation(async () => {
      FakeNotification.permission = 'granted'
      return 'granted'
    })
    act(() => root.render(<MySettings />))

    await act(async () => {
      notificationButton(container).click()
      await Promise.resolve()
    })

    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce()
  })
})
