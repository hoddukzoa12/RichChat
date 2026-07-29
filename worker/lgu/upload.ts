import {
  requestLgu,
  type LguRequest,
} from './http'

const MMS_UPLOAD_PATH = '/file/v1/mms'

interface LguUploadResponse {
  data?: {
    fileId?: unknown
    fileExpDt?: unknown
  }
}

interface UploadMmsFileInput {
  bytes: ArrayBuffer
  fileId: string
  filename: string
  mimeType: string
  officeId: string
}

interface UploadedMmsFile {
  fileId: string
  expiresAt: string
}

export async function uploadMmsFile(
  env: Env,
  input: UploadMmsFileInput,
  lguRequest: LguRequest = requestLgu,
): Promise<UploadedMmsFile> {
  const form = new FormData()
  form.append(
    'reqFile',
    JSON.stringify({
      fileId: input.fileId,
      wideYn: 'N',
      kkoItemListYn: 'N',
      kkoCarouselFeedYn: 'N',
      kkoCarouselCommerceYn: 'N',
    }),
  )
  form.append(
    'filePart',
    new File([input.bytes], input.filename, {
      type: input.mimeType,
    }),
  )

  const response = await lguRequest<LguUploadResponse>(
    env,
    input.officeId,
    'content',
    MMS_UPLOAD_PATH,
    {
      method: 'POST',
      // multipart 경계는 런타임이 FormData에서 만든다.
      // Content-Type을 직접 지정하지 않는다.
      body: form,
    },
  )
  const fileId = response.data?.fileId
  const expiresAt = response.data?.fileExpDt

  if (
    fileId !== input.fileId ||
    typeof expiresAt !== 'string' ||
    expiresAt === ''
  ) {
    throw new Error('LGU+ 첨부 업로드 응답을 확인할 수 없습니다.')
  }

  return { fileId, expiresAt }
}
