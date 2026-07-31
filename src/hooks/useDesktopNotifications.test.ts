import { describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../../shared/wire/event'
import type { ConversationListItem } from '../../shared/wire/conversation'
import type { UserSettings } from '../../shared/wire/settings'
import { initialState, type InboxState } from '../state/inbox'
import {
  desktopNotificationDetails,
  type LiveInboxUpdate,
} from './useDesktopNotifications'

const settings: UserSettings = {
  notifyNewChat: true,
  notifyMineOnly: false,
  notifySound: true,
}

const conversation: ConversationListItem = {
  id: 'conversation-1',
  officeChannel: null,
  customer: {
    id: 'customer-1',
    name: '+821012345678',
    company: '',
    phoneE164: '+821012345678',
  },
  preview: '부가세 신고 기한이 언제인가요?',
  lastMessageAt: 1_900_000_000_000,
  unreadCount: 1,
  assignees: [{ id: 'user-1', name: '김리치' }],
  status: '미처리',
  label: '',
  archived: false,
  version: 2,
}

function event(
  values: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    officeSeq: 1,
    type: 'message.created',
    entity: 'message',
    entityId: 'message-1',
    conversationId: conversation.id,
    actorKind: 'customer',
    actorId: null,
    payload: { direction: 'in', channel: 'SMS' },
    createdAt: 1_900_000_000_001,
    ...values,
  }
}

function before(
  values: Partial<InboxState> = {},
): InboxState {
  return {
    ...initialState,
    convs: [{ ...conversation, preview: '', unreadCount: 0 }],
    selected: 'conversation-other',
    page: 'chat',
    ...values,
  }
}

function update(
  values: Partial<LiveInboxUpdate> = {},
): LiveInboxUpdate {
  return {
    before: before(),
    conversations: [conversation],
    threads: [],
    ...values,
  }
}

describe('Desktop notification selection', () => {
  it('uses the same masked customer display name as the inbox', () => {
    expect(
      desktopNotificationDetails(
        event(),
        update(),
        settings,
        'user-1',
        true,
        1_200,
      ),
    ).toEqual({
      messageId: 'message-1',
      conversationId: conversation.id,
      title: '010-****-5678',
      body: conversation.preview,
    })
  })

  it('suppresses the conversation that is visible in the focused tab', () => {
    expect(
      desktopNotificationDetails(
        event(),
        update({
          before: before({ selected: conversation.id }),
        }),
        settings,
        'user-1',
        true,
        1_200,
      ),
    ).toBeUndefined()
  })

  it('keeps notifying a visible conversation while the tab is unfocused', () => {
    expect(
      desktopNotificationDetails(
        event(),
        update({
          before: before({ selected: conversation.id }),
        }),
        settings,
        'user-1',
        false,
        1_200,
      ),
    ).toBeDefined()
  })

  it('applies the master, direction, and assignee settings', () => {
    expect(
      desktopNotificationDetails(
        event(),
        update(),
        { ...settings, notifyNewChat: false },
        'user-1',
        false,
        1_200,
      ),
    ).toBeUndefined()
    expect(
      desktopNotificationDetails(
        event({ payload: { direction: 'out' }, actorKind: 'user' }),
        update(),
        settings,
        'user-1',
        false,
        1_200,
      ),
    ).toBeUndefined()
    expect(
      desktopNotificationDetails(
        event(),
        update(),
        { ...settings, notifyMineOnly: true },
        'user-2',
        false,
        1_200,
      ),
    ).toBeUndefined()
  })

  it('resolves an untargeted inbound event from the changed list row', () => {
    const details = desktopNotificationDetails(
      event({ conversationId: null }),
      update(),
      settings,
      'user-1',
      false,
      1_200,
    )

    expect(details?.conversationId).toBe(conversation.id)
  })
})
