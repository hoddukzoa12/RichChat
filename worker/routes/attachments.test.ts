import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { AttachmentDownloadStatus } from '../../shared/domain'
import {
  createSession,
  SESSION_COOKIE_NAME,
} from '../http/session'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const NOW = 1_785_229_200_000

interface SeededOffice {
  messageId: string
  officeId: string
  token: string
}

interface CompletedAttachment {
  body: Uint8Array
  filename?: string
  id: string
  mimeType: string
  r2Key?: string
}

let seedSequence = 0

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function seedOffice(): Promise<SeededOffice> {
  seedSequence += 1
  const suffix = `attachment-route-${seedSequence}`
  const officeId = `office-${suffix}`
  const userId = `user-${suffix}`
  const customerId = `customer-${suffix}`
  const conversationId = `conversation-${suffix}`
  const messageId = `message-${suffix}`

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', NOW),
    env.DB.prepare(
      `INSERT INTO users (
        id, office_id, email, name, title, role, status, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      officeId,
      `${userId}@rich.example`,
      '박상담',
      '상담 담당',
      '상담 담당',
      '활성',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO customers (
        id, office_id, phone_e164, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      `+82106${String(seedSequence).padStart(7, '0')}`,
      '첨부 고객',
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
        id, office_id, customer_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(conversationId, officeId, customerId, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO messages (
        id, office_id, conversation_id, direction, channel, body,
        occurred_at, created_at, mo_key, delivery_status
      ) VALUES (?, ?, ?, 'in', 'MMS', '', ?, ?, ?, '수신')`,
    ).bind(
      messageId,
      officeId,
      conversationId,
      NOW,
      NOW,
      `mo-${suffix}`,
    ),
  ])

  const session = await createSession(
    env.DB,
    { userId, officeId },
    Date.now(),
  )

  return { messageId, officeId, token: session.token }
}

async function insertIncompleteAttachment(
  seed: SeededOffice,
  id: string,
  status: Exclude<AttachmentDownloadStatus, '완료'>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO message_attachments (
      id, office_id, message_id, download_status, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, seed.officeId, seed.messageId, status, NOW)
    .run()
}

async function insertCompletedAttachment(
  seed: SeededOffice,
  attachment: CompletedAttachment,
  putObject = true,
): Promise<void> {
  const filename = attachment.filename ?? '첨부파일.bin'
  const r2Key = attachment.r2Key ?? `attachments/${attachment.id}`

  await env.DB.prepare(
    `INSERT INTO message_attachments (
      id, office_id, message_id, original_filename, byte_size,
      mime_type, r2_key, download_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '완료', ?)`,
  )
    .bind(
      attachment.id,
      seed.officeId,
      seed.messageId,
      filename,
      attachment.body.byteLength,
      attachment.mimeType,
      r2Key,
      NOW,
    )
    .run()

  if (putObject) await env.ATTACHMENTS.put(r2Key, attachment.body)
}

function getAttachment(
  id: string,
  token?: string,
  query = '',
  headers?: HeadersInit,
): Promise<Response> {
  const requestHeaders = new Headers(headers)
  if (token) requestHeaders.set('cookie', cookie(token))

  return SELF.fetch(`${ORIGIN}/api/attachments/${id}${query}`, {
    headers: requestHeaders,
  })
}

function rfc5987Filename(contentDisposition: string): string {
  const encoded = contentDisposition.match(
    /filename\*=UTF-8''([^;]+)/u,
  )?.[1]
  if (!encoded) throw new Error('RFC 5987 파일명이 없습니다.')

  return decodeURIComponent(encoded)
}

describe('Attachment serving', () => {
  it('requires an authenticated session', async () => {
    const response = await getAttachment('attachment-without-session')

    expect(response.status).toBe(401)
  })

  it('makes cross-office and missing attachments indistinguishable', async () => {
    const owner = await seedOffice()
    const viewer = await seedOffice()
    await insertCompletedAttachment(owner, {
      id: 'attachment-other-office',
      body: new Uint8Array([1, 2, 3]),
      mimeType: 'image/jpeg',
    })

    const crossOffice = await getAttachment(
      'attachment-other-office',
      viewer.token,
    )
    const missing = await getAttachment(
      'attachment-missing',
      viewer.token,
    )

    expect(crossOffice.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await crossOffice.text()).toBe(await missing.text())
  })

  it('distinguishes pending, failed, and missing attachments', async () => {
    const seed = await seedOffice()
    await insertIncompleteAttachment(seed, 'attachment-pending', '대기')
    await insertIncompleteAttachment(seed, 'attachment-failed', '실패')

    const pending = await getAttachment(
      'attachment-pending',
      seed.token,
    )
    const failed = await getAttachment(
      'attachment-failed',
      seed.token,
    )
    const missing = await getAttachment(
      'attachment-not-found',
      seed.token,
    )

    expect(pending.status).toBe(409)
    await expect(pending.text()).resolves.toContain('받는 중')
    expect(failed.status).toBe(410)
    await expect(failed.text()).resolves.toContain('실패')
    expect(missing.status).toBe(404)
  })

  it('streams completed bytes with private response headers', async () => {
    const seed = await seedOffice()
    const body = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00])
    await insertCompletedAttachment(seed, {
      id: 'attachment-completed',
      body,
      filename: '사업자등록증.jpg',
      mimeType: 'image/jpeg',
    })

    const response = await getAttachment(
      'attachment-completed',
      seed.token,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('content-length')).toBe(
      String(body.byteLength),
    )
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment;/u,
    )
    expect(response.headers.get('x-content-type-options')).toBe(
      'nosniff',
    )
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('accept-ranges')).toBe('none')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
  })

  it('preserves a Korean download filename with RFC 5987', async () => {
    const seed = await seedOffice()
    const filename = '사업자등록증.jpg'
    await insertCompletedAttachment(seed, {
      id: 'attachment-korean-name',
      body: new Uint8Array([1]),
      filename,
      mimeType: 'image/jpeg',
    })

    const response = await getAttachment(
      'attachment-korean-name',
      seed.token,
    )
    const disposition =
      response.headers.get('content-disposition') ?? ''

    expect(disposition).toContain('filename="')
    expect(disposition).toContain("filename*=UTF-8''")
    expect(disposition).not.toContain(filename)
    expect(rfc5987Filename(disposition)).toBe(filename)
    await response.arrayBuffer()
  })

  it('sanitizes unsafe filename characters before writing headers', async () => {
    const seed = await seedOffice()
    await insertCompletedAttachment(seed, {
      id: 'attachment-unsafe-name',
      body: new Uint8Array([1]),
      filename: '../통장"\\사본\r\nX-Evil: injected.pdf',
      mimeType: 'application/pdf',
    })

    const response = await getAttachment(
      'attachment-unsafe-name',
      seed.token,
    )
    const disposition =
      response.headers.get('content-disposition') ?? ''
    const decoded = rfc5987Filename(disposition)

    expect(response.status).toBe(200)
    expect(response.headers.get('x-evil')).toBeNull()
    expect(decoded).not.toMatch(/["\\/\r\n]/u)
    expect(decoded).toContain('통장')
    expect(disposition).toMatch(
      /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/u,
    )
    await response.arrayBuffer()
  })

  it('allows trusted images to render inline', async () => {
    const seed = await seedOffice()
    await insertCompletedAttachment(seed, {
      id: 'attachment-inline-image',
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      filename: '영수증.png',
      mimeType: 'image/png',
    })

    const response = await getAttachment(
      'attachment-inline-image',
      seed.token,
      '?mode=inline',
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('inline')
    expect(response.headers.get('content-type')).toBe('image/png')
    await response.arrayBuffer()
  })

  it.each([
    ['HTML', 'text/html'],
    ['SVG', 'image/svg+xml'],
  ])(
    'forces %s content to download when inline is requested',
    async (label, mimeType) => {
      const seed = await seedOffice()
      const id = `attachment-unsafe-inline-${label.toLowerCase()}`
      await insertCompletedAttachment(seed, {
        id,
        body: new TextEncoder().encode('<script>alert(1)</script>'),
        filename: `${label.toLowerCase()}.txt`,
        mimeType,
      })

      const response = await getAttachment(
        id,
        seed.token,
        '?mode=inline',
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('content-disposition')).toMatch(
        /^attachment;/u,
      )
      expect(response.headers.get('content-type')).toBe(
        'application/octet-stream',
      )
      await response.arrayBuffer()
    },
  )

  it('reports a completed row whose R2 object is missing', async () => {
    const seed = await seedOffice()
    await insertCompletedAttachment(
      seed,
      {
        id: 'attachment-r2-missing',
        body: new Uint8Array([1]),
        mimeType: 'image/jpeg',
      },
      false,
    )

    const response = await getAttachment(
      'attachment-r2-missing',
      seed.token,
    )

    expect(response.status).toBe(500)
    await expect(response.text()).resolves.toContain('저장된 첨부')
  })

  it('explicitly rejects range requests', async () => {
    const seed = await seedOffice()
    await insertCompletedAttachment(seed, {
      id: 'attachment-range',
      body: new Uint8Array([1, 2, 3]),
      mimeType: 'video/mp4',
    })

    const response = await getAttachment(
      'attachment-range',
      seed.token,
      '',
      { range: 'bytes=0-1' },
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('accept-ranges')).toBe('none')
    await expect(response.text()).resolves.toContain(
      '부분 다운로드를 지원하지 않습니다.',
    )
  })
})
