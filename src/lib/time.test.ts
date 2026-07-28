import { describe, expect, it, vi } from 'vitest'
import {
  formatCalendarDate,
  formatClockTime,
  formatRelativeTime,
} from './time'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const NOW = Date.parse('2026-07-28T14:06:00+09:00')

describe('formatRelativeTime', () => {
  it('uses the recent label until 60 seconds', () => {
    expect(formatRelativeTime(NOW - MINUTE_MS + 1, NOW)).toBe('방금')
    expect(formatRelativeTime(NOW - MINUTE_MS, NOW)).toBe('1분 전')
  })

  it('formats minutes until 60 minutes', () => {
    expect(formatRelativeTime(NOW - HOUR_MS + 1, NOW)).toBe('59분 전')
    expect(formatRelativeTime(NOW - HOUR_MS, NOW)).toBe('1시간 전')
  })

  it('formats elapsed hours on the same KST date', () => {
    expect(formatRelativeTime(NOW - 2 * HOUR_MS, NOW)).toBe('2시간 전')
  })

  it('uses Date.now only as the injectable default', () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(NOW)

    expect(formatRelativeTime(NOW - 30_000)).toBe('방금')
    expect(dateNow).toHaveBeenCalledOnce()

    dateNow.mockRestore()
  })

  it('uses the previous KST calendar date as yesterday', () => {
    const justBeforeKstMidnight = Date.parse('2026-07-27T23:59:00+09:00')
    const justAfterKstMidnight = Date.parse('2026-07-28T00:01:00+09:00')

    expect(
      formatRelativeTime(justBeforeKstMidnight, justAfterKstMidnight),
    ).toBe('어제')
  })

  it('formats two through six KST calendar days relatively', () => {
    expect(formatRelativeTime(NOW - 2 * DAY_MS, NOW)).toBe('2일 전')
    expect(formatRelativeTime(NOW - 6 * DAY_MS, NOW)).toBe('6일 전')
  })

  it('uses an absolute date from seven KST calendar days', () => {
    expect(formatRelativeTime(NOW - 7 * DAY_MS, NOW)).toBe('2026년 7월 21일')
  })
})

describe('absolute KST formatting', () => {
  it('formats the morning and afternoon boundary', () => {
    expect(formatClockTime(Date.parse('2026-07-28T11:59:00+09:00'))).toBe(
      '오전 11:59',
    )
    expect(formatClockTime(Date.parse('2026-07-28T12:00:00+09:00'))).toBe(
      '오후 12:00',
    )
  })

  it('formats a calendar date', () => {
    expect(formatCalendarDate(NOW)).toBe('2026년 7월 28일')
  })

  it('does not depend on the process time zone', async () => {
    const processEnv = (
      globalThis as typeof globalThis & {
        process: { env: Record<string, string | undefined> }
      }
    ).process.env
    const originalTimeZone = processEnv.TZ
    const epochMs = Date.parse('2026-07-27T15:30:00Z')

    try {
      processEnv.TZ = 'UTC'
      vi.resetModules()
      const utcTime = await import('./time')
      const utcResult = [
        utcTime.formatRelativeTime(epochMs, NOW),
        utcTime.formatClockTime(epochMs),
        utcTime.formatCalendarDate(epochMs),
      ]

      processEnv.TZ = 'America/New_York'
      vi.resetModules()
      const newYorkTime = await import('./time')
      const newYorkResult = [
        newYorkTime.formatRelativeTime(epochMs, NOW),
        newYorkTime.formatClockTime(epochMs),
        newYorkTime.formatCalendarDate(epochMs),
      ]

      expect(newYorkResult).toEqual(utcResult)
      expect(newYorkResult).toEqual([
        '13시간 전',
        '오전 12:30',
        '2026년 7월 28일',
      ])
    } finally {
      if (originalTimeZone === undefined) {
        delete processEnv.TZ
      } else {
        processEnv.TZ = originalTimeZone
      }
    }
  })
})
