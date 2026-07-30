import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type {
  ConversationDetailResponse,
  ConversationListResponse,
} from '../../shared/wire/conversation'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

describe('Conversation office channel fallback', () => {
  it('keeps a conversation with a null channel visible in list and detail', async () => {
    const now = Date.now()
    const officeId = 'office-null-channel'
    const userId = 'user-null-channel'
    const customerId = 'customer-null-channel'
    const conversationId = 'conversation-null-channel'

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
      ).bind(officeId, '세무법인 리치', now),
      env.DB.prepare(
        `INSERT INTO users (
           id, office_id, email, name, title, role, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
      ).bind(
        userId,
        officeId,
        'null-channel@rich.example',
        '박상담',
        '상담 담당',
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO customers (
           id, office_id, phone_e164, name, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        customerId,
        officeId,
        '+821022334455',
        '채널 미지정 고객',
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO conversations (
           id, office_id, customer_id, office_channel_id, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, ?, ?)`,
      ).bind(conversationId, officeId, customerId, now, now),
    ])
    const session = await createSession(
      env.DB,
      { userId, officeId },
      now,
    )
    const headers = {
      cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
    }

    const listResponse = await SELF.fetch(
      `${ORIGIN}/api/conversations`,
      { headers },
    )
    const list = await listResponse.json<ConversationListResponse>()

    expect(listResponse.status).toBe(200)
    expect(list.conversations).toHaveLength(1)
    expect(list.conversations[0]).toMatchObject({
      id: conversationId,
      officeChannel: null,
      customer: { id: customerId },
    })
    expect(list.facets.status.전체).toBe(1)
    expect(list.facets.scope.all).toBe(1)
    expect(list.facets.archive.active).toBe(1)

    const detailResponse = await SELF.fetch(
      `${ORIGIN}/api/conversations/${conversationId}`,
      { headers },
    )
    const detail = await detailResponse.json<ConversationDetailResponse>()

    expect(detailResponse.status).toBe(200)
    expect(detail.conversation).toMatchObject({
      id: conversationId,
      officeChannel: null,
      customer: { id: customerId },
    })
  })
})
