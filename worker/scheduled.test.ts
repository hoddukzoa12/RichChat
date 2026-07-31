import { env, fetchMock } from 'cloudflare:test'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { LguFetch } from './lgu/protocol'
import {
  MMS_DOWNLOAD_MISSING_ERROR_TEXT,
  MMS_DOWNLOAD_WAIT_MS,
} from './sms-gateway-mms-diagnostics'
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
const DEFAULT_ATTACHMENT_BODY = '사업자등록증'
const DEFAULT_ATTACHMENT_SIZE = new TextEncoder().encode(
  DEFAULT_ATTACHMENT_BODY,
).byteLength
const CLOUDFRONT_ORIGIN =
  'https://df25hb5tuwkue.cloudfront.net/mmsmo/2026/07/29'

interface AttachmentRow {
  download_status: string
  download_lease_until: number
  r2_key: string | null
}

interface SeedOptions {
  attachmentCount?: number
  byteSize?: number | null
  contentUrls?: readonly string[]
  createdAt?: number
}

function quietLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  }
}

function binaryResponse(
  chunks: readonly string[] = [DEFAULT_ATTACHMENT_BODY],
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
  const contentUrls =
    options.contentUrls ??
    attachmentIds.map(
      (_, index) => `${CLOUDFRONT_ORIGIN}/attachment-${suffix}-${index}.jpg`,
    )
  const byteSize =
    options.byteSize === undefined
      ? DEFAULT_ATTACHMENT_SIZE
      : options.byteSize
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
             mime_type, download_status, created_at, content_index,
             content_url
           ) VALUES (?, ?, ?, ?, ?, ?, '대기', ?, ?, ?)`,
        )
        .bind(
          attachmentId,
          officeId,
          messageId,
          `증빙-${contentIndex}.jpg`,
          byteSize,
          'image/jpeg',
          createdAt,
          contentIndex,
          contentUrls[contentIndex],
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
  }
}

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterEach(() => {
  fetchMock.assertNoPendingInterceptors()
  vi.restoreAllMocks()
})

afterAll(() => {
  fetchMock.deactivate()
})

describe('Attachment scheduled download', () => {
  it('streams one MO attachment to R2 and completes it once', async () => {
    const body = '큰 파일 조각 1큰 파일 조각 2'
    const { attachmentIds } = await seedAttachments('101', {
      byteSize: new TextEncoder().encode(body).byteLength,
    })
    const attachmentId = attachmentIds[0]
    const requests: Array<{
      accessClientId: string | null
      accessClientSecret: string | null
      authorization: string | null
      redirect: RequestRedirect | undefined
      url: string
    }> = []
    const response = binaryResponse([body])
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer')
    const fetcher: LguFetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      requests.push({
        accessClientId: headers.get('CF-Access-Client-Id'),
        accessClientSecret: headers.get('CF-Access-Client-Secret'),
        authorization: headers.get('authorization'),
        redirect: init?.redirect,
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
    })
    expect(second.claimed).toBe(0)
    expect(requests).toEqual([
      {
        accessClientId: null,
        accessClientSecret: null,
        authorization: null,
        redirect: 'manual',
        url: `${CLOUDFRONT_ORIGIN}/attachment-101-0.jpg`,
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
      body,
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

  it('calls the real workerd global fetch without an illegal invocation', async () => {
    const { attachmentIds } = await seedAttachments('112')
    fetchMock
      .get(new URL(CLOUDFRONT_ORIGIN).origin)
      .intercept({
        method: 'GET',
        path: '/mmsmo/2026/07/29/attachment-112-0.jpg',
      })
      .reply(200, DEFAULT_ATTACHMENT_BODY, {
        headers: { 'content-type': 'image/jpeg' },
      })

    const summary = await runAttachmentDownloads(env, {
      logger: quietLogger(),
      now: () => NOW,
    })

    expect(summary).toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
      deferred: 0,
    })
    const object = await env.ATTACHMENTS.get(
      `attachments/${attachmentIds[0]}`,
    )
    expect(object?.size).toBe(DEFAULT_ATTACHMENT_SIZE)
    await expect(object?.text()).resolves.toBe(DEFAULT_ATTACHMENT_BODY)
  })

  it('calls an attachment fetcher without an object receiver', async () => {
    const { attachmentIds } = await seedAttachments('113')
    const fetcher: LguFetch = function (
      this: unknown,
      _input,
      _init,
    ): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError('fetcher received an object receiver')
      }
      return Promise.resolve(binaryResponse())
    }

    const summary = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )

    expect(summary.completed).toBe(1)
    expect(
      await env.ATTACHMENTS.head(`attachments/${attachmentIds[0]}`),
    ).not.toBeNull()
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
    const body = '{"증빙":true}'
    const { attachmentIds } = await seedAttachments('108', {
      byteSize: new TextEncoder().encode(body).byteLength,
    })
    const fetcher: LguFetch = async () =>
      binaryResponse([body], 'application/json')

    const summary = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )

    expect(summary.completed).toBe(1)
    const object = await env.ATTACHMENTS.get(
      `attachments/${attachmentIds[0]}`,
    )
    expect(object?.httpMetadata?.contentType).toBe('application/json')
    await expect(object?.text()).resolves.toBe(body)
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

  it('downloads every attachment from a multi-attachment MO', async () => {
    const { attachmentIds } = await seedAttachments('107', {
      attachmentCount: 3,
    })
    const requested: string[] = []
    const fetcher: LguFetch = async (input) => {
      requested.push(String(input))
      return binaryResponse()
    }

    const summary = await runAttachmentDownloads(
      env,
      downloadOptions(fetcher),
    )

    expect(summary).toEqual({
      claimed: 3,
      completed: 3,
      failed: 0,
      deferred: 0,
    })
    expect(requested).toEqual([
      `${CLOUDFRONT_ORIGIN}/attachment-107-0.jpg`,
      `${CLOUDFRONT_ORIGIN}/attachment-107-1.jpg`,
      `${CLOUDFRONT_ORIGIN}/attachment-107-2.jpg`,
    ])
    await expect(
      Promise.all(attachmentIds.map(attachmentRow)),
    ).resolves.toEqual([
      expect.objectContaining({ download_status: '완료' }),
      expect.objectContaining({ download_status: '완료' }),
      expect.objectContaining({ download_status: '완료' }),
    ])
    for (const attachmentId of attachmentIds) {
      const object = await env.ATTACHMENTS.head(
        `attachments/${attachmentId}`,
      )
      expect(object?.size).toBe(DEFAULT_ATTACHMENT_SIZE)
    }
  })

  it('rejects non-CloudFront and non-HTTPS attachment URLs', async () => {
    const disallowed = await seedAttachments('109', {
      contentUrls: ['https://example.com/customer-document.jpg'],
    })
    const insecure = await seedAttachments('110', {
      contentUrls: [
        'http://df25hb5tuwkue.cloudfront.net/customer-document.jpg',
      ],
    })
    const fetcher = vi.fn<LguFetch>()
    const logger = quietLogger()

    const summary = await runAttachmentDownloads(env, {
      ...downloadOptions(fetcher),
      logger,
    })

    expect(summary).toEqual({
      claimed: 2,
      completed: 0,
      failed: 2,
      deferred: 0,
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(2)
    await expect(
      Promise.all([
        attachmentRow(disallowed.attachmentIds[0]),
        attachmentRow(insecure.attachmentIds[0]),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ download_status: '실패' }),
      expect.objectContaining({ download_status: '실패' }),
    ])
  })

  it('removes an object whose size differs from contentSize', async () => {
    const { attachmentIds } = await seedAttachments('111', {
      byteSize: DEFAULT_ATTACHMENT_SIZE + 1,
    })

    const summary = await runAttachmentDownloads(
      env,
      downloadOptions(async () => binaryResponse()),
    )

    expect(summary.deferred).toBe(1)
    expect(
      await env.ATTACHMENTS.head(`attachments/${attachmentIds[0]}`),
    ).toBeNull()
    expect((await attachmentRow(attachmentIds[0]))?.download_status).toBe(
      '대기',
    )
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

  it('promotes stale MMS headers without deleting permanent matches', async () => {
    const staleAt = Date.now() - MMS_DOWNLOAD_WAIT_MS - 1_000
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO sms_gateway_mms_pending (
             mo_key, device_id, sender_e164, raw_json,
             attempts, first_at, last_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          'sms-gateway/device/missing',
          'device',
          '+821022334455',
          '{"event":"mms:received"}',
          staleAt,
          staleAt,
        ),
      env.DB
        .prepare(
          `INSERT INTO sms_gateway_mms_matches (
             downloaded_mo_key, received_mo_key, matched_at
           ) VALUES (?, ?, ?)`,
        )
        .bind(
          'sms-gateway/device/completed',
          'sms-gateway/device/completed-header',
          staleAt,
        ),
    ])

    await runScheduledTasks(env)

    expect(
      await env.DB.prepare(
        `SELECT mo_key, error_text
         FROM mo_failures`,
      ).first(),
    ).toEqual({
      error_text: MMS_DOWNLOAD_MISSING_ERROR_TEXT,
      mo_key: 'sms-gateway/device/missing',
    })
    expect(
      await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM sms_gateway_mms_pending)
             AS pending_count,
           (SELECT COUNT(*) FROM sms_gateway_mms_matches)
             AS match_count`,
      ).first(),
    ).toEqual({
      match_count: 1,
      pending_count: 0,
    })
  })
})
