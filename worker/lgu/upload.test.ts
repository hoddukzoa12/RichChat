import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createLguHttpClient } from './http'
import { uploadMmsFile } from './upload'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

describe('LGU MMS file upload', () => {
  it('sends the production-observed multipart contract through Access', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]).buffer
    let capturedRequest: Request | null = null
    const requestLgu = createLguHttpClient({
      tokenProvider: async () => 'upload-access-token',
      fetch: async function (
        this: unknown,
        input,
        init,
      ): Promise<Response> {
        expect(this).toBeUndefined()
        capturedRequest = new Request(input, init)
        return Response.json({
          code: '10000',
          message: '성공',
          data: {
            ch: 'mms',
            imgUrl: null,
            imgUrlLst: null,
            fileId: 'attachment-file-id',
            fileExpDt: '2027-07-29T00:00:00',
          },
        })
      },
    })

    const result = await uploadMmsFile(
      env,
      {
        bytes,
        fileId: 'attachment-file-id',
        filename: '세무자료.jpg',
        mimeType: 'image/jpeg',
        officeId: 'office-upload',
      },
      requestLgu,
    )

    expect(result).toEqual({
      fileId: 'attachment-file-id',
      expiresAt: '2027-07-29T00:00:00',
    })
    expect(capturedRequest).not.toBeNull()
    const captured = capturedRequest as unknown as Request
    expect(captured.url).toBe(
      `https://${env.LGU_CONTENT_HOST}/file/v1/mms`,
    )
    expect(captured.headers.get('authorization')).toBe(
      'Bearer upload-access-token',
    )
    expect(captured.headers.get('CF-Access-Client-Id')).toBe(
      env.CF_ACCESS_CLIENT_ID,
    )
    expect(captured.headers.get('CF-Access-Client-Secret')).toBe(
      env.CF_ACCESS_CLIENT_SECRET,
    )
    expect(captured.headers.get('content-type')).toMatch(
      /^multipart\/form-data; boundary=/u,
    )

    const form = await captured.formData()
    const reqFile = form.get('reqFile')
    expect(typeof reqFile).toBe('string')
    expect(JSON.parse(reqFile as string)).toEqual({
      fileId: 'attachment-file-id',
      wideYn: 'N',
      kkoItemListYn: 'N',
      kkoCarouselFeedYn: 'N',
      kkoCarouselCommerceYn: 'N',
    })

    const filePart = form.get('filePart')
    expect(filePart).toBeInstanceOf(File)
    expect(filePart).toMatchObject({
      name: '세무자료.jpg',
      type: 'image/jpeg',
      size: bytes.byteLength,
    })
    await expect((filePart as File).arrayBuffer()).resolves.toEqual(
      bytes,
    )
  })
})
