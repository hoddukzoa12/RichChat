export const COMPOSE_IMAGE_LIMITS = Object.freeze({
  count: 3,
  byteSize: 300 * 1024,
  width: 1500,
  height: 1440,
})

const JPEG_QUALITY = Object.freeze({
  min: 0.1,
  max: 0.92,
  attempts: 8,
})

type ComposeImageErrorCode =
  | 'not-image'
  | 'heic-unsupported'
  | 'decode-failed'
  | 'encode-failed'

const IMAGE_ERROR_COPY: Record<
  ComposeImageErrorCode,
  (filename: string) => string
> = {
  'not-image': (filename) =>
    `${filename}은(는) 이미지 파일이 아닙니다.`,
  'heic-unsupported': (filename) =>
    `${filename}은(는) 이 브라우저에서 변환할 수 없는 HEIC 이미지입니다. JPG 또는 PNG로 바꿔 주세요.`,
  'decode-failed': (filename) =>
    `${filename} 이미지를 읽을 수 없습니다. 손상되었거나 지원하지 않는 형식입니다.`,
  'encode-failed': (filename) =>
    `${filename} 이미지를 300KB 이하 JPEG로 변환할 수 없습니다.`,
}

const IMAGE_FILENAME = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i
const HEIC_FILENAME = /\.(?:heic|heif)$/i

export class ComposeImageError extends Error {
  constructor(
    readonly code: ComposeImageErrorCode,
    filename: string,
  ) {
    super(IMAGE_ERROR_COPY[code](filename))
    this.name = 'ComposeImageError'
  }
}

export interface ComposeImageSize {
  width: number
  height: number
}

export interface PreparedComposeImage extends ComposeImageSize {
  file: File
}

interface DecodedImage extends ComposeImageSize {
  source: CanvasImageSource
  dispose: () => void
}

export function imageSelectionError(file: File): string | null {
  if (
    file.type.toLowerCase().startsWith('image/') ||
    IMAGE_FILENAME.test(file.name)
  ) {
    return null
  }

  return new ComposeImageError('not-image', file.name).message
}

export function fitComposeImageSize(
  width: number,
  height: number,
): ComposeImageSize {
  const scale = Math.min(
    1,
    COMPOSE_IMAGE_LIMITS.width / width,
    COMPOSE_IMAGE_LIMITS.height / height,
  )

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function jpegFilename(filename: string): string {
  const basename = filename.replace(/\.[^.]+$/, '') || 'image'
  return `${basename}.jpg`
}

async function decodeWithImageElement(file: File): Promise<DecodedImage> {
  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  image.decoding = 'async'
  image.src = objectUrl

  try {
    await image.decode()
  } catch {
    URL.revokeObjectURL(objectUrl)
    throw new ComposeImageError(
      HEIC_FILENAME.test(file.name) ||
        /image\/hei[cf]/i.test(file.type)
        ? 'heic-unsupported'
        : 'decode-failed',
      file.name,
    )
  }

  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dispose: () => URL.revokeObjectURL(objectUrl),
  }
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap !== 'function') {
    return decodeWithImageElement(file)
  }

  try {
    // 명시적으로 EXIF 방향을 적용해 휴대폰 사진을 화면에 보이는 방향으로 정규화한다.
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
    })
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close(),
    }
  } catch {
    return decodeWithImageElement(file)
  }
}

function renderCanvas(
  image: CanvasImageSource,
  size: ComposeImageSize,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas 2D context is unavailable.')
  }

  // 투명 PNG가 JPEG에서 검게 변하지 않도록 흰 배경 위에 합성한다.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size.width, size.height)
  context.drawImage(image, 0, 0, size.width, size.height)
  return canvas
}

function encodeJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
        } else {
          reject(new Error('Canvas JPEG encoding failed.'))
        }
      },
      'image/jpeg',
      quality,
    )
  })
}

async function bestJpegWithinLimit(
  canvas: HTMLCanvasElement,
): Promise<{ blob: Blob | null; smallest: Blob }> {
  let lower: number = JPEG_QUALITY.min
  let upper: number = JPEG_QUALITY.max
  let best: Blob | null = null
  let smallest = await encodeJpeg(canvas, lower)

  if (smallest.size <= COMPOSE_IMAGE_LIMITS.byteSize) {
    best = smallest
  }

  for (let attempt = 0; attempt < JPEG_QUALITY.attempts; attempt += 1) {
    const quality = (lower + upper) / 2
    const candidate = await encodeJpeg(canvas, quality)

    if (candidate.size <= COMPOSE_IMAGE_LIMITS.byteSize) {
      best = candidate
      lower = quality
    } else {
      upper = quality
      if (candidate.size < smallest.size) smallest = candidate
    }
  }

  return { blob: best, smallest }
}

function nextSmallerSize(
  size: ComposeImageSize,
  byteSize: number,
): ComposeImageSize {
  const ratio = Math.min(
    0.9,
    Math.sqrt(COMPOSE_IMAGE_LIMITS.byteSize / byteSize) * 0.92,
  )
  return {
    width: Math.max(1, Math.floor(size.width * ratio)),
    height: Math.max(1, Math.floor(size.height * ratio)),
  }
}

export async function prepareComposeImage(
  sourceFile: File,
): Promise<PreparedComposeImage> {
  const selectionError = imageSelectionError(sourceFile)
  if (selectionError) {
    throw new ComposeImageError('not-image', sourceFile.name)
  }

  const decoded = await decodeImage(sourceFile)
  let size = fitComposeImageSize(decoded.width, decoded.height)

  try {
    for (let resizeAttempt = 0; resizeAttempt < 8; resizeAttempt += 1) {
      const canvas = renderCanvas(decoded.source, size)
      const encoded = await bestJpegWithinLimit(canvas)

      if (encoded.blob) {
        return {
          file: new File(
            [encoded.blob],
            jpegFilename(sourceFile.name),
            {
              type: 'image/jpeg',
              lastModified: sourceFile.lastModified,
            },
          ),
          ...size,
        }
      }

      const smaller = nextSmallerSize(size, encoded.smallest.size)
      if (
        smaller.width === size.width &&
        smaller.height === size.height
      ) {
        break
      }
      size = smaller
    }
  } catch {
    throw new ComposeImageError('encode-failed', sourceFile.name)
  } finally {
    decoded.dispose()
  }

  throw new ComposeImageError('encode-failed', sourceFile.name)
}
