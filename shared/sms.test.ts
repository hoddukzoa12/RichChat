import { describe, expect, it } from 'vitest'
import {
  LMS_MAX_BYTES,
  LMS_TITLE_MAX_BYTES,
  SMS_MAX_BYTES,
  containsEmoji,
  pickMessageType,
  smsByteLength,
} from './sms'

describe('smsByteLength', () => {
  it('counts ASCII as one byte and Korean as two bytes', () => {
    expect(smsByteLength('')).toBe(0)
    expect(smsByteLength('a')).toBe(1)
    expect(smsByteLength('가')).toBe(2)
    expect(smsByteLength('a가')).toBe(3)
  })

  it('counts a surrogate pair once', () => {
    expect(smsByteLength('😀')).toBe(2)
  })
})

describe('pickMessageType', () => {
  it('uses the exact SMS byte boundary', () => {
    expect(SMS_MAX_BYTES).toBe(90)
    expect(pickMessageType('가'.repeat(45))).toBe('SMS')
    expect(pickMessageType('가'.repeat(46))).toBe('LMS')
  })

  it('uses the exact LMS byte boundary', () => {
    expect(LMS_MAX_BYTES).toBe(2000)
    expect(pickMessageType('가'.repeat(1000))).toBe('LMS')
    expect(pickMessageType('가'.repeat(1001))).toBe('TOO_LONG')
  })

  it('exports the LMS title byte limit', () => {
    expect(LMS_TITLE_MAX_BYTES).toBe(40)
  })
})

describe('containsEmoji', () => {
  it('detects emoji without deciding the sending policy', () => {
    expect(containsEmoji('문의 😀')).toBe(true)
    expect(containsEmoji('문의 🇰🇷')).toBe(true)
    expect(containsEmoji('문의 1️⃣')).toBe(true)
  })

  it('accepts text without emoji', () => {
    expect(containsEmoji('문자 message 123')).toBe(false)
  })
})
