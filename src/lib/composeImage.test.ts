import { describe, expect, it } from 'vitest'
import {
  COMPOSE_IMAGE_LIMITS,
  fitComposeImageSize,
  imageSelectionError,
} from './composeImage'

describe('composer image preparation', () => {
  it('fits landscape and portrait images within the outbound bounds', () => {
    expect(fitComposeImageSize(3000, 1000)).toEqual({
      width: 1500,
      height: 500,
    })
    expect(fitComposeImageSize(1000, 3000)).toEqual({
      width: 480,
      height: 1440,
    })
    expect(fitComposeImageSize(800, 600)).toEqual({
      width: 800,
      height: 600,
    })
  })

  it('keeps the LGU+ limits in one exported definition', () => {
    expect(COMPOSE_IMAGE_LIMITS).toEqual({
      count: 3,
      byteSize: 300 * 1024,
      width: 1500,
      height: 1440,
    })
  })

  it('accepts browser images and rejects non-image files with a reason', () => {
    const png = new File(['png'], 'screenshot.png', {
      type: 'image/png',
    })
    const heic = new File(['heic'], 'photo.heic', {
      type: '',
    })
    const pdf = new File(['pdf'], 'contract.pdf', {
      type: 'application/pdf',
    })

    expect(imageSelectionError(png)).toBeNull()
    expect(imageSelectionError(heic)).toBeNull()
    expect(imageSelectionError(pdf)).toBe(
      'contract.pdf은(는) 이미지 파일이 아닙니다.',
    )
  })
})
