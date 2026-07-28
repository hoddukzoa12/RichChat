import { env } from 'cloudflare:test'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { LguFetch } from './lgu/protocol'
import {
  ATTACHMENT_DOWNLOAD_LEASE_MS,
  LGU_ATTACHMENT_RECOVERY_WINDOW_MS,
  runAttachmentDownloads,
  runScheduledTasks,
} from './scheduled'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const NOW = 1_800_000_000_000
const TOKEN = 'attachment-access-token'

interface AttachmentRow {
  download_status: string
  download_lease_until: number
  r2_key: string | null
}

interface SeedOptions {
  attachmentCount?: number
  createdAt?: number
}

function quietLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  }
}

function binaryResponse(
  chunks: readonly string[] = ['사업자', '등록증'],
  contentType = 'image/jpeg',
): Response {
  return new Response(chunks.join(''), {
    headers: { 'content-type': contentType },
  })
}

async function seedAttachments(
  suffix: string,
  options: SeedOptions = {},
): Promise<{
  attachmentIds: string[]
  messageId: string
  moKey: string
}> {
  const officeId = `scheduled-office-${suffix}`
  const customerId = `scheduled-customer-${suffix}`
  const conversationId = `scheduled-conversation-${suffix}`
  const messageId = `scheduled-message-${suffix}`
  const moKey = `scheduled-mo-${suffix}`
  const createdAt = options.createdAt ?? NOW
  const attachmentCount = options.attachmentCount ?? 1
  const attachmentIds = Array.from(
    { length: attachmentCount },
    (_, index) => `scheduled-attachment-${suffix}-${index}`,
  )
  const statements = [
    env.DB.prepare(
      'INSERT INTO offices (id, name, created_at) VALUES (?, ?, ?)',
    ).bind(officeId, '세무법인 리치', createdAt),
    env.DB.prepare(
      `INSERT INTO customers (
         id, office_id, phone_e164, name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      customerId,
      officeId,
      `+8210${suffix.replaceAll(/\D/g, '').padStart(8, '0').slice(-8)}`,
      '첨부 고객',
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO conversations (
         id, office_id, customer_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      conversationId,
      officeId,
      customerId,
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO messages (
         id, office_id, conversation_id, direction, channel, body,
         occurred_at, created_at, mo_key, delivery_status
       ) VALUES (?, ?, ?, 'in', 'MMS', '', ?, ?, ?, '수신')`,
    ).bind(
      messageId,
      officeId,
      conversationId,
      createdAt,
      createdAt,
      moKey,
    ),
    ...attachmentIds.map((attachmentId, contentIndex) =>
      env.DB
        .prepare(
          `INSERT INTO message_attachments (
             id, office_id, message_id, original_filename, byte_size,
             mime_type, download_status, created_at, content_index
           ) VALUES (?, ?, ?, ?, ?, ?, '대기', ?, ?)`,
        )
        .bind(
          attachmentId,
          officeId,
          messageId,
          `증빙-${contentIndex}.jpg`,
          1024,
          'image/jpeg',
          createdAt,
          contentIndex,
        ),
    ),
  ]

  await env.DB.batch(statements)
  return { attachmentIds, messageId, moKey }
}

async function attachmentRow(id: string): Promise<AttachmentRow | null> {
  return await env.DB.prepare(
    `SELECT download_status, download_lease_until, r2_key
     FROM message_attachments
     WHERE id = ?`,
  )
    .bind(id)
    .first<AttachmentRow>()
}

function downloadOptions(
  fetcher: LguFetch,
  now: () => number = () => NOW,
) {
  return {
    fetch: fetcher,
    logger: quietLogger(),
    now,
    tokenProvider: async () => TOKEN,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Attachment scheduled download', () => {
  it('streams one MO attachment to R2 and completes it once', async () => {
    const { attachmentIds, moKey } = await seedAttachments('101')
    const attachmentId = attachmentIds[0]
    const requests: Array<{ authorization: string | null; url: string }> = []
    const response = binaryResponse(['큰 파일 조각 1', '큰 파일 조각 2'])
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer')
    const fetcher: LguFetch = async (input, init) => {
      requests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        url: String(input),
      })
      return response
    }

    const first = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )
    const second = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )

    expect(first).toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
      deferred: 0,
      ambiguousMessages: 0,
    })
    expect(second.claimed).toBe(0)
    expect(requests).toEqual([
      {
        authorization: `Bearer ${TOKEN}`,
        url: `https://${env.LGU_CONTENT_HOST}/mo/v1/file/${moKey}`,
      },
    ])
    expect(arrayBuffer).not.toHaveBeenCalled()

    const row = await attachmentRow(attachmentId)
    expect(row).toEqual({
      download_status: '완료',
      download_lease_until: 0,
      r2_key: `attachments/${attachmentId}`,
    })
    const object = await env.ATTACHMENTS.get(`attachments/${attachmentId}`)
    expect(object).not.toBeNull()
    await expect(object?.text()).resolves.toBe(
      '큰 파일 조각 1큰 파일 조각 2',
    )

    const eventCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM events
       WHERE entity = 'attachment' AND entity_id = ?`,
    )
      .bind(attachmentId)
      .first<{ count: number }>()
    expect(eventCount?.count).toBe(1)
  })

  it('claims an attachment once across concurrent runs', async () => {
    const { attachmentIds } = await seedAttachments('102')
    let releaseDownload: (() => void) | undefined
    let notifyStarted: (() => void) | undefined
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve
    })
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    let calls = 0
    const fetcher: LguFetch = async () => {
      calls += 1
      notifyStarted?.()
      await downloadGate
      return binaryResponse()
    }

    const firstRun = runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )
    await started
    const second = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )

    expect(second.claimed).toBe(0)
    expect(calls).toBe(1)
    releaseDownload?.()
    await firstRun
    expect((await attachmentRow(attachmentIds[0]))?.download_status).toBe(
      '완료',
    )
  })

  it('does not restrict the inbound attachment format', async () => {
    const { attachmentIds } = await seedAttachments('108')
    const fetcher: LguFetch = async () =>
      binaryResponse(['{"증빙":true}'], 'application/json')

    const summary = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )

    expect(summary.completed).toBe(1)
    const object = await env.ATTACHMENTS.get(
      `attachments/${attachmentIds[0]}`,
    )
    expect(object?.httpMetadata?.contentType).toBe('application/json')
    await expect(object?.text()).resolves.toBe('{"증빙":true}')
  })

  it('keeps a 5xx failure pending and succeeds after the lease', async () => {
    const { attachmentIds } = await seedAttachments('103')
    let currentTime = NOW
    let calls = 0
    const fetcher: LguFetch = async () => {
      calls += 1
      return calls === 1
        ? new Response('temporary', { status: 503 })
        : binaryResponse()
    }
    const options = downloadOptions(fetcher, () => currentTime)

    const failedAttempt = await runAttachmentDownloads(env, options)
    expect(failedAttempt.deferred).toBe(1)
    expect((await attachmentRow(attachmentIds[0]))?.download_status).toBe(
      '대기',
    )

    currentTime += ATTACHMENT_DOWNLOAD_LEASE_MS + 1
    const retry = await runAttachmentDownloads(env, options)
    expect(retry.completed).toBe(1)
    expect(calls).toBe(2)
  })

  it('keeps a timeout pending', async () => {
    const { attachmentIds } = await seedAttachments('104')
    const fetcher: LguFetch = async () => {
      throw new DOMException('timed out', 'TimeoutError')
    }

    const summary = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )

    expect(summary.deferred).toBe(1)
    expect((await attachmentRow(attachmentIds[0]))?.download_status).toBe(
      '대기',
    )
  })

  it('fails a definitively missing file without retrying', async () => {
    const { attachmentIds } = await seedAttachments('105')
    let calls = 0
    const fetcher: LguFetch = async () => {
      calls += 1
      return new Response('missing', { status: 404 })
    }

    const first = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )
    const second = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )

    expect(first.failed).toBe(1)
    expect(second.claimed).toBe(0)
    expect(calls).toBe(1)
    expect((await attachmentRow(attachmentIds[0]))?.download_status).toBe(
      '실패',
    )
  })

  it('expires an attachment after the recovery window without fetching', async () => {
    const { attachmentIds } = await seedAttachments('106', {
      createdAt: NOW - LGU_ATTACHMENT_RECOVERY_WINDOW_MS - 1,
    })
    const fetcher = vi.fn<LguFetch>()

    const first = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )
    const second = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )

    expect(first.failed).toBe(1)
    expect(second.claimed).toBe(0)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await attachmentRow(attachmentIds[0]))?.download_status).toBe(
      '실패',
    )
  })

  it('does not guess the mapping for multiple MO attachments', async () => {
    const { attachmentIds } = await seedAttachments('107', {
      attachmentCount: 2,
    })
    const fetcher = vi.fn<LguFetch>()
    const logger = quietLogger()

    const summary = await runAttachmentDownloads(env, {
      ...downloadOptions(fetcher),
      logger,
    })

    expect(summary).toEqual({
      claimed: 0,
      completed: 0,
      failed: 0,
      deferred: 0,
      ambiguousMessages: 1,
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('복수 첨부'),
      expect.any(Object),
    )
    await expect(
      Promise.all(attachmentIds.map(attachmentRow)),
    ).resolves.toEqual([
      expect.objectContaining({ download_status: '대기' }),
      expect.objectContaining({ download_status: '대기' }),
    ])
  })

  it('runs later scheduled tasks when one task fails', async () => {
    const calls: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runScheduledTasks(env, [
      async () => {
        calls.push('failed')
        throw new Error('scheduled failure')
      },
      async () => {
        calls.push('completed')
      },
    ])

    expect(calls).toEqual(['failed', 'completed'])
    expect(error).toHaveBeenCalledOnce()
  })
})
