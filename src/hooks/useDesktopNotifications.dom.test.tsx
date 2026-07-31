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
import type { EventEnvelope } from '../../shared/wire/event'
import type { ConversationListItem } from '../../shared/wire/conversation'
import type { UserSettings } from '../../shared/wire/settings'
import { initialState, type Action } from '../state/inbox'
import {
  useDesktopNotifications,
  type LiveInboxUpdate,
} from './useDesktopNotifications'

const conversation: ConversationListItem = {
  id: 'conversation-notification',
  officeChannel: null,
  customer: {
    id: 'customer-1',
    name: '김리치',
    company: '',
    phoneE164: '+821012345678',
  },
  preview: '새 문의입니다.',
  lastMessageAt: 1_900_000_000_000,
  unreadCount: 1,
  assignees: [{ id: 'user-1', name: '박상담' }],
  status: '미처리',
  label: '',
  archived: false,
  version: 2,
}

const settings: UserSettings = {
  notifyNewChat: true,
  notifyMineOnly: false,
  notifySound: true,
}

function event(messageId: string): EventEnvelope {
  return {
    officeSeq: 1,
    type: 'message.created',
    entity: 'message',
    entityId: messageId,
    conversationId: conversation.id,
    actorKind: 'customer',
    actorId: null,
    payload: { direction: 'in' },
    createdAt: 1_900_000_000_001,
  }
}

function update(): LiveInboxUpdate {
  return {
    before: {
      ...initialState,
      page: 'settings',
      selected: 'conversation-other',
      convs: [{ ...conversation, unreadCount: 0, preview: '' }],
    },
    conversations: [conversation],
    threads: [],
  }
}

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static instances: FakeNotification[] = []

  readonly close = vi.fn()
  onclick: (() => void) | null = null

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this)
  }
}

function fakeStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe('Desktop notification browser wiring', () => {
  let root: Root
  let container: HTMLDivElement
  let notifyLive: ReturnType<typeof useDesktopNotifications>
  let dispatch: ReturnType<typeof vi.fn<(action: Action) => void>>
  let play: ReturnType<typeof vi.fn<() => Promise<void>>>

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean
      }
    ).IS_REACT_ACT_ENVIRONMENT = true
    FakeNotification.instances = []
    vi.stubGlobal(
      'Notification',
      FakeNotification as unknown as typeof Notification,
    )
    play = vi.fn(() => Promise.resolve())
    vi.stubGlobal(
      'Audio',
      class {
        volume = 1
        play = play
      },
    )
    vi.stubGlobal('localStorage', fakeStorage())
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    dispatch = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    function Harness() {
      notifyLive = useDesktopNotifications(
        settings,
        'user-1',
        dispatch,
      )
      return null
    }

    act(() => root.render(<Harness />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens the matching conversation when clicked', async () => {
    await act(() => notifyLive([event('message-click')], update()))

    const notification = FakeNotification.instances[0]
    expect(notification?.title).toBe('김리치')
    expect(notification?.options?.body).toBe('새 문의입니다.')

    act(() => notification?.onclick?.())

    expect(window.focus).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: 'setPage', page: 'chat' },
      { type: 'select', id: conversation.id },
    ])
    expect(notification?.close).toHaveBeenCalledOnce()
  })

  it('plays the bundled sound only when enabled', async () => {
    await act(() => notifyLive([event('message-sound')], update()))
    expect(play).toHaveBeenCalledOnce()

    function SilentHarness() {
      notifyLive = useDesktopNotifications(
        { ...settings, notifySound: false },
        'user-1',
        dispatch,
      )
      return null
    }
    act(() => root.render(<SilentHarness />))
    await act(() => notifyLive([event('message-silent')], update()))

    expect(play).toHaveBeenCalledOnce()
  })

  it('deduplicates the same message id', async () => {
    const incoming = event('message-duplicate')
    await act(() => notifyLive([incoming], update()))
    await act(() => notifyLive([incoming], update()))

    expect(FakeNotification.instances).toHaveLength(1)
  })
})
