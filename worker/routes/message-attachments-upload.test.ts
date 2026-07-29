import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { OUTBOUND_IMAGE_LIMITS } from '../../shared/attachments'
import type { UploadMessageAttachmentsResponse } from '../../shared/wire/message-send'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
let seedSequence = 0

interface Fixture {
  conversationId: string
  token: string
}

async function seedFixture(): Promise<Fixture> {
  seedSequence += 1
  const suffix = `message-attachment-upload-${seedSequence}`
  const officeId = `office-${suffix}`
  const userId = `user-${suffix}`
  const customerId = `customer-${suffix}`
  const conversationId = `conversation-${suffix}`
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', now),
    env.DB.prepare(
      `INSERT INTO users (
         id, office_id, email, name, title, role, status, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, '상담 담당', '활성', ?, ?)`,
    ).bind(
      userId,
      officeId,
      `${suffix}@rich.test`,
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
      `+8210${String(seedSequence).padStart(8, '0')}`,
      '테스트 고객',
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
         id, office_id, customer_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(conversationId, officeId, customerId, now, now),
  ])
  const session = await createSession(
    env.DB,
    { userId, officeId },
    now,
  )

  return { conversationId, token: session.token }
}

function jpegFile(
  name = '세무자료.jpg',
  size = 12,
): File {
  const bytes = new Uint8Array(size)
  bytes.set([0xff, 0xd8, 0xff])
  return new File([bytes], name, { type: 'image/jpeg' })
}

function upload(
  fixture: Fixture,
  files: File[],
): Promise<Response> {
  const form = new FormData()
  for (const file of files) form.append('files', file)
  form.set('fileId', 'client-controlled-file-id')

  return SELF.fetch(
    `${ORIGIN}/api/conversations/${fixture.conversationId}/attachments`,
    {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${fixture.token}`,
        origin: ORIGIN,
      },
      body: form,
    },
  )
}

describe('Message attachment upload route', () => {
  it('stores a validated image in R2 and returns the thread attachment shape', async () => {
    const fixture = await seedFixture()
    const response = await upload(fixture, [jpegFile()])
    const body = await response.json<UploadMessageAttachmentsResponse>()
    const attachment = body.attachments[0]

    expect(response.status).toBe(201)
    expect(attachment).toMatchObject({
      originalFilename: '세무자료.jpg',
      byteSize: 12,
      mimeType: 'image/jpeg',
      downloadStatus: '완료',
    })
    expect(attachment?.id).not.toBe('client-controlled-file-id')
    expect(attachment).toHaveProperty('createdAt')

    const object = await env.ATTACHMENTS.head(
      `attachments/${attachment?.id}`,
    )
    expect(object?.size).toBe(12)
    const row = await env.DB.prepare(
      `SELECT
         id, conversation_id, original_filename, byte_size, mime_type,
         r2_key
       FROM outbound_attachment_uploads
       WHERE id = ?`,
    )
      .bind(attachment?.id)
      .first()
    expect(row).toEqual({
      id: attachment?.id,
      conversation_id: fixture.conversationId,
      original_filename: '세무자료.jpg',
      byte_size: 12,
      mime_type: 'image/jpeg',
      r2_key: `attachments/${attachment?.id}`,
    })
  })

  it('rejects PNG, an oversized image, and a fourth image before R2 writes', async () => {
    const fixture = await seedFixture()
    const png = new File(
      [Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
      '위장된화면.jpg',
      { type: 'image/jpeg' },
    )
    const oversized = jpegFile(
      '큰사진.jpg',
      OUTBOUND_IMAGE_LIMITS.byteSize + 1,
    )

    const responses = await Promise.all([
      upload(fixture, [png]),
      upload(fixture, [oversized]),
      upload(fixture, [
        jpegFile('1.jpg'),
        jpegFile('2.jpg'),
        jpegFile('3.jpg'),
        jpegFile('4.jpg'),
      ]),
    ])

    expect(responses.map(({ status }) => status)).toEqual([
      400,
      400,
      400,
    ])
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM outbound_attachment_uploads
       WHERE conversation_id = ?`,
    )
      .bind(fixture.conversationId)
      .first<{ count: number }>()
    expect(row?.count).toBe(0)
  })
})
