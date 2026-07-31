import { useCallback, useEffect, useRef, type Dispatch } from 'react'
import { EVENT_ACTOR_KINDS } from '../../shared/domain'
import type {
  EventCursorGoneResponse,
  EventEnvelope,
} from '../../shared/wire/event'
import type { UserSettings } from '../../shared/wire/settings'
import { ApiRequestError } from '../api/client'
import {
  getConversationDetail,
  getConversationMessages,
  getConversations,
  getEvents,
} from '../api/endpoints'
import type { Action, InboxState } from '../state/inbox'
import {
  applyRealtimeFrame,
  RealtimeCursor,
  type EventBatchApplier,
} from '../state/realtime'
import { conversationListParams } from '../state/selectors'
import { useDesktopNotifications } from './useDesktopNotifications'

type PageVisibility = 'hidden' | 'visible'
type SocketConnection = 'connected' | 'disconnected'

const POLL_INTERVAL_MS: Record<
  SocketConnection,
  Record<PageVisibility, number>
> = {
  disconnected: {
    visible: 5_000,
    hidden: 30_000,
  },
  connected: {
    visible: 60_000,
    hidden: 300_000,
  },
}
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const NORMAL_CLOSE_CODE = 1_000

type ReloadableResource = 'card' | 'thread'

const RESOURCE_ENTITIES: Record<
  ReloadableResource,
  ReadonlySet<string>
> = {
  card: new Set(['conversation', 'customer', 'note', 'task']),
  thread: new Set(['attachment', 'message']),
}

interface RealtimeCallbacks {
  applyCatchUpEvents: EventBatchApplier
  applyLiveEvents: EventBatchApplier
  fullResync: (signal: AbortSignal) => Promise<void>
}

interface RealtimeLocation {
  href: string
  protocol: string
}

interface SocketEventSource {
  addEventListener(
    type: 'open' | 'close',
    listener: () => void,
  ): void
}

interface PollingSchedule {
  start: () => void
  reschedule: () => void
  observe: (socket: SocketEventSource) => void
  stop: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isActorKind(
  value: unknown,
): value is EventEnvelope['actorKind'] {
  return (
    typeof value === 'string' &&
    EVENT_ACTOR_KINDS.includes(value as EventEnvelope['actorKind'])
  )
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!isRecord(value)) return false
  return (
    Number.isSafeInteger(value.officeSeq) &&
    (value.officeSeq as number) > 0 &&
    typeof value.type === 'string' &&
    typeof value.entity === 'string' &&
    typeof value.entityId === 'string' &&
    (value.conversationId === null ||
      typeof value.conversationId === 'string') &&
    isActorKind(value.actorKind) &&
    (value.actorId === null || typeof value.actorId === 'string') &&
    Number.isSafeInteger(value.createdAt) &&
    Object.hasOwn(value, 'payload')
  )
}

function eventFrame(data: unknown): EventEnvelope | undefined {
  if (typeof data !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    return isEventEnvelope(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function realtimeWebSocketUrl(
  location: RealtimeLocation,
): string {
  const url = new URL('/api/realtime', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function reconnectDelay(attempt: number): number {
  return Math.min(
    RECONNECT_BASE_MS * 2 ** Math.min(attempt, 10),
    RECONNECT_MAX_MS,
  )
}

export function pollingDelay(
  hidden: boolean,
  connected: boolean,
): number {
  const visibility = hidden ? 'hidden' : 'visible'
  const connection = connected ? 'connected' : 'disconnected'
  return POLL_INTERVAL_MS[connection][visibility]
}

export function createPollingSchedule(
  poll: () => Promise<void>,
  isHidden: () => boolean,
): PollingSchedule {
  let timer: number | undefined
  let connected = false
  let disposed = false

  const schedule = (): void => {
    globalThis.clearTimeout(timer)
    if (disposed) return
    timer = globalThis.setTimeout(() => {
      timer = undefined
      void poll().catch(() => undefined).finally(schedule)
    }, pollingDelay(isHidden(), connected))
  }

  return {
    start: schedule,
    reschedule: schedule,
    observe(socket) {
      socket.addEventListener('open', () => {
        if (disposed) return
        connected = true
        schedule()
      })
      socket.addEventListener('close', () => {
        if (disposed) return
        connected = false
        schedule()
      })
    },
    stop() {
      disposed = true
      globalThis.clearTimeout(timer)
      timer = undefined
    },
  }
}

function isGoneDetail(
  value: unknown,
): value is EventCursorGoneResponse['error']['detail'] {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.currentCursor) &&
    (value.currentCursor as number) >= 0
  )
}

function goneCursor(error: ApiRequestError): number | undefined {
  return isGoneDetail(error.detail)
    ? error.detail.currentCursor
    : undefined
}

export async function recoverGoneCursor(
  error: ApiRequestError,
  cursor: RealtimeCursor,
  fullResync: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  const currentSeq = goneCursor(error)
  if (error.status !== 410 || currentSeq === undefined) return false

  await fullResync(signal)
  cursor.reset(currentSeq)
  return true
}

function protocolError(message: string): ApiRequestError {
  return new ApiRequestError('server', message)
}

/**
 * 폴링과 소켓이 공유하는 단일 구독 루프다. 모든 변경은 직렬 큐를 지나므로
 * WebSocket 프레임이 캐치업 응답을 앞질러 커서를 전진시킬 수 없다.
 */
function useRealtimeSubscription({
  applyCatchUpEvents,
  applyLiveEvents,
  fullResync,
}: RealtimeCallbacks): void {
  const callbacksRef = useRef({
    applyCatchUpEvents,
    applyLiveEvents,
    fullResync,
  })
  callbacksRef.current = {
    applyCatchUpEvents,
    applyLiveEvents,
    fullResync,
  }

  useEffect(() => {
    const cursor = new RealtimeCursor()
    const activeRequests = new Set<AbortController>()
    let disposed = false
    let socket: WebSocket | null = null
    let connecting = false
    let reconnectTimer: number | undefined
    let reconnectAttempt = 0
    let queue: Promise<void> = Promise.resolve()
    let pollingCanNotify = false

    const withSignal = async (
      operation: (signal: AbortSignal) => Promise<void>,
    ): Promise<void> => {
      if (disposed) return
      const controller = new AbortController()
      activeRequests.add(controller)
      try {
        await operation(controller.signal)
      } finally {
        activeRequests.delete(controller)
      }
    }

    const enqueue = (
      operation: (signal: AbortSignal) => Promise<void>,
    ): Promise<void> => {
      const next = queue.then(
        () => withSignal(operation),
        () => withSignal(operation),
      )
      queue = next.catch(() => undefined)
      return next
    }

    const catchUp = async (
      signal: AbortSignal,
      applyEvents: EventBatchApplier,
    ): Promise<void> => {
      try {
        while (!signal.aborted) {
          const since = cursor.lastSeq
          const response = await getEvents(since, signal)
          const expectedNext =
            response.events.at(-1)?.officeSeq ?? since
          if (
            response.nextCursor !== expectedNext ||
            (response.hasMore && response.events.length === 0)
          ) {
            throw protocolError(
              '이벤트 캐치업 응답의 커서가 연속적이지 않습니다.',
            )
          }

          const applied = await cursor.apply(
            response.events,
            applyEvents,
            signal,
          )
          if (!applied) {
            throw protocolError(
              '이벤트 캐치업 응답에 순서가 끊긴 구간이 있습니다.',
            )
          }
          if (!response.hasMore) return
        }
      } catch (error: unknown) {
        if (!(error instanceof ApiRequestError) || error.status !== 410) {
          throw error
        }

        const recovered = await recoverGoneCursor(
          error,
          cursor,
          callbacksRef.current.fullResync,
          signal,
        )
        if (!recovered) throw error
        await catchUp(
          signal,
          callbacksRef.current.applyCatchUpEvents,
        )
      }
    }

    const pollingSchedule = createPollingSchedule(
      () =>
        enqueue(async (signal) => {
          try {
            await catchUp(
              signal,
              pollingCanNotify
                ? callbacksRef.current.applyLiveEvents
                : callbacksRef.current.applyCatchUpEvents,
            )
            pollingCanNotify = true
          } catch (error) {
            pollingCanNotify = false
            throw error
          }
        }),
      () => document.hidden,
    )

    const scheduleReconnect = (): void => {
      if (disposed || reconnectTimer !== undefined) return
      const delay = reconnectDelay(reconnectAttempt)
      reconnectAttempt += 1
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        void enqueue(recoverAndConnect).catch(scheduleReconnect)
      }, delay)
    }

    const openSocket = (): void => {
      if (disposed || connecting || socket) return
      connecting = true

      let nextSocket: WebSocket
      try {
        nextSocket = new WebSocket(
          realtimeWebSocketUrl(window.location),
        )
      } catch {
        connecting = false
        scheduleReconnect()
        return
      }
      socket = nextSocket
      pollingSchedule.observe(nextSocket)

      nextSocket.addEventListener('open', () => {
        if (disposed || socket !== nextSocket) return
        connecting = false
        void enqueue(async (signal) => {
          await catchUp(
            signal,
            callbacksRef.current.applyCatchUpEvents,
          )
          pollingCanNotify = true
        })
          .then(() => {
            reconnectAttempt = 0
          })
          .catch(() => nextSocket.close())
      })
      nextSocket.addEventListener('message', (event) => {
        if (disposed || socket !== nextSocket) return
        const frame = eventFrame(event.data)
        void enqueue((signal) =>
          applyRealtimeFrame(
            frame,
            cursor,
            (catchUpSignal) =>
              catchUp(
                catchUpSignal,
                callbacksRef.current.applyCatchUpEvents,
              ),
            callbacksRef.current.applyLiveEvents,
            signal,
          ),
        ).catch(() => undefined)
      })
      nextSocket.addEventListener('error', () => {
        if (socket === nextSocket) nextSocket.close()
      })
      nextSocket.addEventListener('close', () => {
        if (socket === nextSocket) socket = null
        connecting = false
        pollingCanNotify = false
        scheduleReconnect()
      })
    }

    async function recoverAndConnect(
      signal: AbortSignal,
    ): Promise<void> {
      if (!window.navigator.onLine) {
        scheduleReconnect()
        return
      }
      await catchUp(
        signal,
        callbacksRef.current.applyCatchUpEvents,
      )
      pollingCanNotify = true
      openSocket()
    }

    const onVisibilityChange = (): void => {
      pollingSchedule.reschedule()
      if (document.hidden) return
      void enqueue(recoverAndConnect).catch(() => undefined)
    }

    const onOnline = (): void => {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      void enqueue(recoverAndConnect).catch(scheduleReconnect)
    }

    document.addEventListener(
      'visibilitychange',
      onVisibilityChange,
    )
    window.addEventListener('online', onOnline)
    pollingSchedule.start()
    void enqueue(recoverAndConnect).catch(scheduleReconnect)

    return () => {
      disposed = true
      document.removeEventListener(
        'visibilitychange',
        onVisibilityChange,
      )
      window.removeEventListener('online', onOnline)
      pollingSchedule.stop()
      window.clearTimeout(reconnectTimer)
      for (const controller of activeRequests) controller.abort()
      activeRequests.clear()
      const currentSocket = socket
      socket = null
      currentSocket?.close(NORMAL_CLOSE_CODE, 'unmounted')
    }
  }, [])
}

function touchesResource(
  events: readonly EventEnvelope[],
  resource: ReloadableResource,
): boolean {
  const entities = RESOURCE_ENTITIES[resource]
  return events.some((event) => entities.has(event.entity))
}

function reloadIds(
  state: InboxState,
  events: readonly EventEnvelope[],
  resource: ReloadableResource,
  full: boolean,
): string[] {
  const loaded =
    resource === 'thread'
      ? Object.keys(state.threads)
      : Object.keys(state.cardEntries)
  if (full) {
    return [
      ...new Set(
        state.selected ? [...loaded, state.selected] : loaded,
      ),
    ]
  }
  if (!touchesResource(events, resource)) return []

  const relevant = events.filter((event) =>
    RESOURCE_ENTITIES[resource].has(event.entity),
  )
  const affected = new Set(
    relevant.flatMap((event) =>
      event.conversationId ? [event.conversationId] : [],
    ),
  )
  const needsSelectedFallback = relevant.some(
    (event) => event.conversationId === null,
  )
  return loaded.filter(
    (id) =>
      affected.has(id) ||
      (needsSelectedFallback && id === state.selected),
  )
}

export async function reloadInboxState(
  state: InboxState,
  dispatch: Dispatch<Action>,
  events: readonly EventEnvelope[],
  full: boolean,
  signal: AbortSignal,
): Promise<{
  list: Awaited<ReturnType<typeof getConversations>>
  threads: Array<{
    conversationId: string
    page: Awaited<ReturnType<typeof getConversationMessages>>
  }>
}> {
  const threadIds = reloadIds(state, events, 'thread', full)
  const cardIds = reloadIds(state, events, 'card', full)
  const [list, threads, cards] = await Promise.all([
    getConversations(conversationListParams(state), signal),
    Promise.all(
      threadIds.map(async (conversationId) => ({
        conversationId,
        page: await getConversationMessages(conversationId, {
          signal,
        }),
      })),
    ),
    Promise.all(
      cardIds.map(async (conversationId) => ({
        conversationId,
        response: await getConversationDetail(
          conversationId,
          signal,
        ),
      })),
    ),
  ])
  signal.throwIfAborted()

  dispatch({
    type: 'conversationListLoadSucceeded',
    requestId: state.listRequestId,
    append: false,
    response: list,
  })
  for (const { conversationId, page } of threads) {
    dispatch({
      type: 'thread/loadSucceeded',
      conversationId,
      messages: page.messages,
      nextCursor: page.nextCursor,
      older: false,
    })
  }
  for (const { response } of cards) {
    dispatch({
      type: 'cardData',
      action: {
        type: 'cardLoadSucceeded',
        detail: response.conversation,
      },
    })
  }
  return { list, threads }
}

export function useRealtime(
  state: InboxState,
  dispatch: Dispatch<Action>,
  settings: UserSettings,
  userId: string,
): void {
  const stateRef = useRef(state)
  stateRef.current = state
  const notifyLiveEvents = useDesktopNotifications(
    settings,
    userId,
    dispatch,
  )

  const applyCatchUpEvents = useCallback<EventBatchApplier>(
    async (events, signal) => {
      await reloadInboxState(
        stateRef.current,
        dispatch,
        events,
        false,
        signal,
      )
    },
    [dispatch],
  )
  const applyLiveEvents = useCallback<EventBatchApplier>(
    async (events, signal) => {
      const before = stateRef.current
      const notificationListRequest =
        !before.archivedView &&
        before.scope === 'all' &&
        before.filter === '전체' &&
        before.query.trim() === ''
          ? null
          : getConversations(
              conversationListParams({
                ...before,
                archivedView: false,
                scope: 'all',
                filter: '전체',
                query: '',
              }),
              signal,
            )
      const reloaded = await reloadInboxState(
        before,
        dispatch,
        events,
        false,
        signal,
      )
      const notificationList =
        (await notificationListRequest) ?? reloaded.list
      await notifyLiveEvents(events, {
        before,
        conversations: notificationList.conversations,
        threads: reloaded.threads.map(({ conversationId, page }) => ({
          conversationId,
          messages: page.messages,
        })),
      })
    },
    [dispatch, notifyLiveEvents],
  )
  const fullResync = useCallback(
    async (signal: AbortSignal) => {
      await reloadInboxState(
        stateRef.current,
        dispatch,
        [],
        true,
        signal,
      )
    },
    [dispatch],
  )

  useRealtimeSubscription({
    applyCatchUpEvents,
    applyLiveEvents,
    fullResync,
  })
}
