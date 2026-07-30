import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type {
  Direction,
  SendChannel,
} from '../../shared/domain'
import {
  MESSAGE_PAGE_SIZE,
  type MessagePageResponse,
} from '../../shared/wire/message'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'
import {
  routes,
  THREAD_MESSAGES_BEFORE_SQL,
} from './conversation-detail'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const NOW = 1_785_229_200_000

interface SeededConversation {
  conversationId: string
  customerId: string
  officeId: string
  senderId: string
  senderName: string
  token: string
  viewerId: string
}

interface MessageSeed {
  body?: string
  direction?: Direction
  id: string
  occurredAt: number
  senderId?: string
}

let seedSequence = 0

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function seedConversation(): Promise<SeededConversation> {
  seedSequence += 1
  const suffix = `b7-${seedSequence}`
  const officeId = `office-${suffix}`
  const viewerId = `viewer-${suffix}`
  const senderId = `sender-${suffix}`
  const customerId = `customer-${suffix}`
  const conversationId = `conversation-${suffix}`
  const officeChannelId = `office-channel-${suffix}`
  const senderName = `김세무-${suffix}`

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', NOW),
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      viewerId,
      officeId,
      `${viewerId}@rich.example`,
      `박상담-${suffix}`,
      '상담 담당',
      '상담 담당',
      '활성',
      NOW,
      NOW,
    ),
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      senderId,
      officeId,
      `${senderId}@rich.example`,
      senderName,
      '세무사',
      '세무사',
      '활성',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id,
        office_id,
        phone_e164,
        name,
        company,
        role_title,
        version,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      `+8210555${String(seedSequence).padStart(4, '0')}`,
      `홍고객-${suffix}`,
      '(주)리치',
      '대표',
      4,
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO office_channels (
        id, office_id, value, label, is_default, active, created_at
      ) VALUES (?, ?, ?, ?, 1, 1, ?)`,
    ).bind(
      officeChannelId,
      officeId,
      `0105555${String(seedSequence).padStart(4, '0')}`,
      '업무폰 1',
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id,
        office_id,
        customer_id,
        office_channel_id,
        status,
        label,
        archived_at,
        version,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      conversationId,
      officeId,
      customerId,
      officeChannelId,
      '처리중',
      '신고',
      NOW,
      7,
      NOW,
      NOW,
    ),
  ])

  const session = await createSession(
    env.DB,
    { userId: viewerId, officeId },
    Date.now(),
  )

  return {
    conversationId,
    customerId,
    officeId,
    senderId,
    senderName,
    token: session.token,
    viewerId,
  }
}

function insertMessage(
  seed: SeededConversation,
  message: MessageSeed,
): D1PreparedStatement {
  const direction = message.direction ?? 'out'
  const senderId =
    direction === 'out' ? (message.senderId ?? seed.senderId) : null
  const moKey = direction === 'in' ? `mo-${message.id}` : null
  const clientKey =
    direction === 'out' ? `client-${message.id}` : null
  const deliveryStatus = direction === 'in' ? '수신' : '완료'

  return env.DB.prepare(
    `INSERT INTO messages (
      id,
      office_id,
      conversation_id,
      direction,
      channel,
      title,
      body,
      sender_user_id,
      occurred_at,
      created_at,
      mo_key,
      client_key,
      delivery_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    message.id,
    seed.officeId,
    seed.conversationId,
    direction,
    'SMS' satisfies SendChannel,
    null,
    message.body ?? message.id,
    senderId,
    message.occurredAt,
    message.occurredAt,
    moKey,
    clientKey,
    deliveryStatus,
  )
}

async function fetchDetail(
  seed: SeededConversation,
  id = seed.conversationId,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/conversations/${id}`, {
    headers: { cookie: cookie(seed.token) },
  })
}

async function fetchMessages(
  seed: SeededConversation,
  query = '',
  id = seed.conversationId,
): Promise<Response> {
  return SELF.fetch(
    `${ORIGIN}/api/conversations/${id}/messages${query}`,
    {
      headers: { cookie: cookie(seed.token) },
    },
  )
}

async function messagePage(response: Response): Promise<MessagePageResponse> {
  return (await response.json()) as MessagePageResponse
}

function messageKey(
  message: MessagePageResponse['messages'][number],
): [number, string] {
  return [message.occurredAt, message.id]
}

function isAscending(
  messages: MessagePageResponse['messages'],
): boolean {
  return messages.every((message, index) => {
    if (index === 0) return true

    const previous = messageKey(messages[index - 1])
    const current = messageKey(message)
    return (
      previous[0] < current[0] ||
      (previous[0] === current[0] && previous[1] < current[1])
    )
  })
}

describe('Conversation detail routes', () => {
  it.each([
    '/api/conversations/missing',
    '/api/conversations/missing/messages',
  ])('requires a session cookie for %s', async (path) => {
    const response = await SELF.fetch(`${ORIGIN}${path}`)

    expect(response.status).toBe(401)
  })

  it('returns customer, assignees, tasks, notes, and versions', async () => {
    const seed = await seedConversation()

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO customer_fields (
          id,
          customer_id,
          office_id,
          key,
          value,
          sort_order,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `field-${seed.customerId}`,
        seed.customerId,
        seed.officeId,
        '사업자번호',
        '123-45-67890',
        1,
        NOW,
      ),
      env.DB.prepare(
        `INSERT INTO conversation_assignees (
          conversation_id,
          office_id,
          user_id,
          assigned_at,
          assigned_by
        ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        seed.conversationId,
        seed.officeId,
        seed.senderId,
        NOW,
        seed.viewerId,
      ),
      env.DB.prepare(
        `INSERT INTO tasks (
          id,
          office_id,
          conversation_id,
          name,
          sub,
          kind,
          sort_order,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `task-active-${seed.conversationId}`,
        seed.officeId,
        seed.conversationId,
        '부가세 신고',
        '기한 8/10',
        'warn',
        1,
        seed.senderId,
        NOW,
        NOW,
      ),
      env.DB.prepare(
        `INSERT INTO tasks (
          id,
          office_id,
          conversation_id,
          name,
          kind,
          sort_order,
          created_by,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `task-deleted-${seed.conversationId}`,
        seed.officeId,
        seed.conversationId,
        '삭제된 업무',
        'done',
        2,
        seed.senderId,
        NOW,
        NOW,
        NOW,
      ),
      env.DB.prepare(
        `INSERT INTO notes (
          id,
          office_id,
          conversation_id,
          author_id,
          body,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `note-active-${seed.conversationId}`,
        seed.officeId,
        seed.conversationId,
        seed.senderId,
        '내부 확인 필요',
        NOW,
        NOW,
      ),
      env.DB.prepare(
        `INSERT INTO notes (
          id,
          office_id,
          conversation_id,
          author_id,
          body,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `note-deleted-${seed.conversationId}`,
        seed.officeId,
        seed.conversationId,
        seed.senderId,
        '삭제된 메모',
        NOW,
        NOW,
        NOW,
      ),
    ])

    const response = await fetchDetail(seed)
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      conversation: {
        id: seed.conversationId,
        officeChannel: {
          id: `office-channel-b7-${seedSequence}`,
          label: '업무폰 1',
        },
        status: '처리중',
        label: '신고',
        archived: true,
        version: 7,
        customer: {
          id: seed.customerId,
          name: `홍고객-b7-${seedSequence}`,
          company: '(주)리치',
          roleTitle: '대표',
          version: 4,
          fields: [
            {
              key: '사업자번호',
              value: '123-45-67890',
              sortOrder: 1,
            },
          ],
        },
        assignees: [
          {
            id: seed.senderId,
            name: seed.senderName,
            title: '세무사',
          },
        ],
        tasks: [
          {
            name: '부가세 신고',
            sub: '기한 8/10',
            kind: 'warn',
            sortOrder: 1,
            createdById: seed.senderId,
          },
        ],
        notes: [
          {
            authorId: seed.senderId,
            authorName: seed.senderName,
            body: '내부 확인 필요',
          },
        ],
      },
    })
    expect(body.conversation).not.toHaveProperty('messages')
    expect(JSON.stringify(body)).not.toContain('삭제된 업무')
    expect(JSON.stringify(body)).not.toContain('삭제된 메모')
  })

  it('returns the same 404 for missing detail and message history', async () => {
    const seed = await seedConversation()
    const detail = await fetchDetail(seed, 'missing-conversation')
    const messages = await fetchMessages(
      seed,
      '',
      'missing-conversation',
    )

    expect(detail.status).toBe(404)
    expect(messages.status).toBe(404)
    expect(await detail.json()).toEqual(await messages.json())
  })

  it('keeps the actual outbound sender and makes inbound sender null', async () => {
    const seed = await seedConversation()
    await env.DB.batch([
      insertMessage(seed, {
        id: `message-in-${seed.conversationId}`,
        direction: 'in',
        occurredAt: NOW,
      }),
      insertMessage(seed, {
        id: `message-out-${seed.conversationId}`,
        occurredAt: NOW + 1,
      }),
    ])

    const response = await fetchMessages(seed)
    const page = await messagePage(response)

    expect(response.status).toBe(200)
    expect(page.messages).toHaveLength(2)
    expect(page.messages[0]).toMatchObject({
      direction: 'in',
      sender: null,
    })
    expect(page.messages[1]).toMatchObject({
      direction: 'out',
      sender: {
        id: seed.senderId,
        name: seed.senderName,
        title: '세무사',
      },
    })
    expect(page.messages[1].sender?.id).not.toBe(seed.viewerId)
  })

  it('paginates backward without gaps when a newer message arrives', async () => {
    const seed = await seedConversation()
    const originalIds = Array.from(
      { length: 6 },
      (_, index) =>
        `message-${String(index + 1).padStart(3, '0')}-${seed.conversationId}`,
    )
    await env.DB.batch(
      originalIds.map((id, index) =>
        insertMessage(seed, {
          id,
          occurredAt: NOW + Math.floor(index / 2),
        }),
      ),
    )

    const firstResponse = await fetchMessages(seed, '?limit=2')
    const first = await messagePage(firstResponse)
    expect(first.nextCursor).not.toBeNull()
    expect(isAscending(first.messages)).toBe(true)

    const newMessageId = `message-new-${seed.conversationId}`
    await insertMessage(seed, {
      id: newMessageId,
      occurredAt: NOW + 100,
    }).run()

    const secondResponse = await fetchMessages(
      seed,
      `?limit=2&before=${first.nextCursor}`,
    )
    const second = await messagePage(secondResponse)
    expect(second.nextCursor).not.toBeNull()
    expect(isAscending(second.messages)).toBe(true)

    const thirdResponse = await fetchMessages(
      seed,
      `?limit=2&before=${second.nextCursor}`,
    )
    const third = await messagePage(thirdResponse)
    expect(third.nextCursor).toBeNull()
    expect(isAscending(third.messages)).toBe(true)

    const pagedIds = [third, second, first].flatMap((page) =>
      page.messages.map((message) => message.id),
    )
    expect(pagedIds).toEqual(originalIds)
    expect(new Set(pagedIds).size).toBe(originalIds.length)
    expect(pagedIds).not.toContain(newMessageId)
  })

  it('returns attachment metadata and pending download status without R2 data', async () => {
    const seed = await seedConversation()
    const messageId = `message-attachment-${seed.conversationId}`
    await insertMessage(seed, {
      id: messageId,
      occurredAt: NOW,
    }).run()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO message_attachments (
          id,
          office_id,
          message_id,
          original_filename,
          byte_size,
          mime_type,
          r2_key,
          download_status,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `attachment-complete-${seed.conversationId}`,
        seed.officeId,
        messageId,
        '신고서.pdf',
        321,
        'application/pdf',
        `private-r2-key-${seed.conversationId}`,
        '완료',
        NOW,
      ),
      env.DB.prepare(
        `INSERT INTO message_attachments (
          id,
          office_id,
          message_id,
          download_status,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        `attachment-pending-${seed.conversationId}`,
        seed.officeId,
        messageId,
        '대기',
        NOW + 1,
      ),
    ])

    const response = await fetchMessages(seed)
    const page = await messagePage(response)
    const attachments = page.messages[0].attachments

    expect(response.status).toBe(200)
    expect(attachments).toEqual([
      {
        id: `attachment-complete-${seed.conversationId}`,
        originalFilename: '신고서.pdf',
        byteSize: 321,
        mimeType: 'application/pdf',
        downloadStatus: '완료',
        createdAt: NOW,
      },
      {
        id: `attachment-pending-${seed.conversationId}`,
        originalFilename: null,
        byteSize: null,
        mimeType: null,
        downloadStatus: '대기',
        createdAt: NOW + 1,
      },
    ])
    expect(JSON.stringify(attachments)).not.toContain(
      `private-r2-key-${seed.conversationId}`,
    )
    expect(attachments[0]).not.toHaveProperty('r2Key')
    expect(attachments[0]).not.toHaveProperty('binary')
  })

  it('uses a fixed query count for a conversation with 200 messages', async () => {
    const seed = await seedConversation()
    const statements = Array.from({ length: 200 }, (_, index) =>
      insertMessage(seed, {
        id: `message-${String(index).padStart(3, '0')}-${seed.conversationId}`,
        occurredAt: NOW + index,
      }),
    )
    for (let index = 0; index < statements.length; index += 50) {
      await env.DB.batch(statements.slice(index, index + 50))
    }

    let prepareCount = 0
    const countingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (query: string) => {
            prepareCount += 1
            return target.prepare(query)
          }
        }

        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const countingEnv = new Proxy(env, {
      get(target, property) {
        if (property === 'DB') return countingDb
        return Reflect.get(target, property, target)
      },
    }) as Env
    const route = routes.find(
      ({ method, path }) =>
        method === 'GET' &&
        path === '/api/conversations/:id/messages',
    )

    expect(route).toBeDefined()
    const response = await route?.handler(
      new Request(
        `${ORIGIN}/api/conversations/${seed.conversationId}/messages`,
        { headers: { cookie: cookie(seed.token) } },
      ),
      countingEnv,
      { id: seed.conversationId },
    )

    expect(response?.status).toBe(200)
    expect(prepareCount).toBe(4)
    const page = await messagePage(response as Response)
    expect(page.messages).toHaveLength(MESSAGE_PAGE_SIZE)
  })

  it('uses the thread keyset index in the query plan', async () => {
    const seed = await seedConversation()
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${THREAD_MESSAGES_BEFORE_SQL}`,
    )
      .bind(
        seed.conversationId,
        seed.officeId,
        NOW,
        'message-cursor',
        MESSAGE_PAGE_SIZE + 1,
      )
      .all<{ detail: string }>()
    const plan = results.map(({ detail }) => detail).join('\n')

    expect(plan).toContain('ix_messages_conversation_occurred')
    expect(plan).not.toMatch(/\bSCAN messages\b/)
  })

  it('rejects malformed cursors and out-of-range limits', async () => {
    const seed = await seedConversation()
    const invalidCursor = await fetchMessages(seed, '?before=not-a-cursor')
    const invalidLimit = await fetchMessages(
      seed,
      `?limit=${MESSAGE_PAGE_SIZE + 1}`,
    )

    expect(invalidCursor.status).toBe(400)
    expect(invalidLimit.status).toBe(400)
  })
})
