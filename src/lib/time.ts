const KST_TIME_ZONE = 'Asia/Seoul'

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const RECENT_SECONDS = 60
const ABSOLUTE_DATE_AFTER_DAYS = 7

const calendarPartsFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
})

const clockFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

const calendarDateFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})

function kstDayNumber(epochMs: number): number {
  const parts = calendarPartsFormatter.formatToParts(epochMs)
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type === 'year' || type === 'month' || type === 'day')
      .map(({ type, value }) => [type, Number(value)]),
  )

  return Math.floor(Date.UTC(values.year, values.month - 1, values.day) / DAY_MS)
}

export function formatRelativeTime(
  epochMs: number,
  now: number = Date.now(),
): string {
  const elapsedMs = now - epochMs

  if (elapsedMs < RECENT_SECONDS * SECOND_MS) {
    return '방금'
  }

  const dayDifference = kstDayNumber(now) - kstDayNumber(epochMs)

  if (dayDifference === 0) {
    if (elapsedMs < HOUR_MS) {
      return `${Math.floor(elapsedMs / MINUTE_MS)}분 전`
    }

    return `${Math.floor(elapsedMs / HOUR_MS)}시간 전`
  }

  if (dayDifference === 1) {
    return '어제'
  }

  if (dayDifference < ABSOLUTE_DATE_AFTER_DAYS) {
    return `${dayDifference}일 전`
  }

  return formatCalendarDate(epochMs)
}

export function formatClockTime(epochMs: number): string {
  return clockFormatter.format(epochMs)
}

export function formatCalendarDate(epochMs: number): string {
  return calendarDateFormatter.format(epochMs)
}
