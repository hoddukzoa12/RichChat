import {
  useCallback,
  useRef,
  type Dispatch,
} from 'react'
import { MOBILE_MAX } from '../../shared/breakpoints'
import type { EventEnvelope } from '../../shared/wire/event'
import type {
  ConversationListItem,
} from '../../shared/wire/conversation'
import type { ConversationMessage } from '../../shared/wire/message'
import type { UserSettings } from '../../shared/wire/settings'
import { NOTIFICATION_SOUND_URL } from '../data/notificationSound'
import { customerDisplayName } from '../lib/customer'
import type { Action, InboxState } from '../state/inbox'

const NOTIFICATION_STORAGE_PREFIX = 'richchat:notification:'
const NOTIFICATION_STORAGE_TTL_MS = 24 * 60 * 60 * 1_000
const NOTIFICATION_LOCK_NAME = 'richchat:desktop-notification'
const notifiedMessageIds = new Set<string>()

export type DesktopNotificationPermission =
  | NotificationPermission
  | 'unsupported'

export interface LiveInboxUpdate {
  before: InboxState
  conversations: ConversationListItem[]
  threads: Array<{
    conversationId: string
    messages: ConversationMessage[]
  }>
}

export interface DesktopNotificationDetails {
  messageId: string
  conversationId: string
  title: string
  body: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInboundMessageCreated(event: EventEnvelope): boolean {
  if (event.type !== 'message.created' || event.entity !== 'message') {
    return false
  }
  if (isRecord(event.payload) && event.payload.direction === 'out') {
    return false
  }
  return (
    (isRecord(event.payload) && event.payload.direction === 'in') ||
    event.actorKind === 'customer'
  )
}

function messageFromThreads(
  event: EventEnvelope,
  threads: LiveInboxUpdate['threads'],
): { conversationId: string; message: ConversationMessage } | undefined {
  for (const thread of threads) {
    const message = thread.messages.find(
      (candidate) => candidate.id === event.entityId,
    )
    if (message) return { conversationId: thread.conversationId, message }
  }
  return undefined
}

function changedConversation(
  before: InboxState,
  conversations: ConversationListItem[],
): ConversationListItem | undefined {
  const previousById = new Map(
    before.convs.map((conversation) => [conversation.id, conversation]),
  )
  return conversations.find((conversation) => {
    const previous = previousById.get(conversation.id)
    if (!previous) return conversation.unreadCount > 0
    return (
      conversation.unreadCount > previous.unreadCount &&
      (conversation.lastMessageAt !== previous.lastMessageAt ||
        conversation.preview !== previous.preview)
    )
  })
}

function conversationIsVisible(
  state: InboxState,
  conversationId: string,
  focused: boolean,
  viewportWidth: number,
): boolean {
  if (!focused || state.page !== 'chat') return false
  const openConversationId = state.selected ?? state.convs[0]?.id
  if (openConversationId !== conversationId) return false
  return viewportWidth >= MOBILE_MAX || state.mobileView === 'chat'
}

export function desktopNotificationDetails(
  event: EventEnvelope,
  update: LiveInboxUpdate,
  settings: UserSettings,
  userId: string,
  focused: boolean,
  viewportWidth: number,
): DesktopNotificationDetails | undefined {
  if (!settings.notifyNewChat || !isInboundMessageCreated(event)) {
    return undefined
  }

  const loadedMessage = messageFromThreads(event, update.threads)
  const conversationId =
    event.conversationId ??
    loadedMessage?.conversationId ??
    changedConversation(update.before, update.conversations)?.id
  if (!conversationId) return undefined

  const conversation = update.conversations.find(
    (candidate) => candidate.id === conversationId,
  )
  if (!conversation) return undefined
  if (
    settings.notifyMineOnly &&
    !conversation.assignees.some((assignee) => assignee.id === userId)
  ) {
    return undefined
  }
  if (
    conversationIsVisible(
      update.before,
      conversationId,
      focused,
      viewportWidth,
    )
  ) {
    return undefined
  }

  return {
    messageId: event.entityId,
    conversationId,
    title: customerDisplayName(conversation.customer),
    body: loadedMessage?.message.body ?? conversation.preview,
  }
}

export function readDesktopNotificationPermission(): DesktopNotificationPermission {
  return typeof Notification === 'undefined'
    ? 'unsupported'
    : Notification.permission
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

function removeExpiredClaims(now: number): void {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (!key?.startsWith(NOTIFICATION_STORAGE_PREFIX)) continue
      const claimedAt = Number(localStorage.getItem(key))
      if (!Number.isFinite(claimedAt) || now - claimedAt > NOTIFICATION_STORAGE_TTL_MS) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // 저장소가 막힌 브라우저에서는 현재 탭의 Set 멱등만 유지한다.
  }
}

function storedClaimExists(messageId: string): boolean {
  try {
    return localStorage.getItem(
      `${NOTIFICATION_STORAGE_PREFIX}${messageId}`,
    ) !== null
  } catch {
    return false
  }
}

function storeClaim(messageId: string): void {
  try {
    localStorage.setItem(
      `${NOTIFICATION_STORAGE_PREFIX}${messageId}`,
      String(Date.now()),
    )
  } catch {
    // Web Locks와 현재 탭 Set은 유지된다. 저장소까지 막히면 탭 간 중복은 허용한다.
  }
}

async function claimAndShow(
  messageId: string,
  show: () => boolean,
): Promise<void> {
  if (notifiedMessageIds.has(messageId)) return
  notifiedMessageIds.add(messageId)

  let attempted = false
  const attempt = (): void => {
    attempted = true
    removeExpiredClaims(Date.now())
    if (storedClaimExists(messageId)) return
    if (show()) storeClaim(messageId)
  }

  try {
    if (navigator.locks) {
      await navigator.locks.request(NOTIFICATION_LOCK_NAME, attempt)
    } else {
      attempt()
    }
  } catch {
    if (!attempted) attempt()
  }
}

function playNotificationSound(): void {
  try {
    const audio = new Audio(NOTIFICATION_SOUND_URL)
    audio.volume = 0.35
    void audio.play().catch(() => undefined)
  } catch {
    // 사용자 상호작용 전 자동재생 거부와 미지원 환경은 알림 자체를 막지 않는다.
  }
}

function showNotification(
  details: DesktopNotificationDetails,
  notifySound: boolean,
  dispatch: Dispatch<Action>,
): boolean {
  if (
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  ) {
    return false
  }

  try {
    const notification = new Notification(details.title, {
      body: details.body,
      icon: '/logo.png',
      silent: true,
      tag: `richchat:${details.messageId}`,
    })
    notification.onclick = () => {
      window.focus()
      dispatch({ type: 'setPage', page: 'chat' })
      dispatch({ type: 'select', id: details.conversationId })
      notification.close()
    }
    if (notifySound) playNotificationSound()
    return true
  } catch {
    return false
  }
}

export function useDesktopNotifications(
  settings: UserSettings,
  userId: string,
  dispatch: Dispatch<Action>,
): (
  events: readonly EventEnvelope[],
  update: LiveInboxUpdate,
) => Promise<void> {
  const configRef = useRef({ settings, userId })
  configRef.current = { settings, userId }

  return useCallback(
    async (
      events: readonly EventEnvelope[],
      update: LiveInboxUpdate,
    ): Promise<void> => {
      if (readDesktopNotificationPermission() !== 'granted') return

      for (const event of events) {
        const details = desktopNotificationDetails(
          event,
          update,
          configRef.current.settings,
          configRef.current.userId,
          document.hasFocus(),
          window.innerWidth,
        )
        if (!details) continue
        await claimAndShow(details.messageId, () =>
          showNotification(
            details,
            configRef.current.settings.notifySound,
            dispatch,
          ),
        )
      }
    },
    [dispatch],
  )
}
