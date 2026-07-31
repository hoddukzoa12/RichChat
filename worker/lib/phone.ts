export function normalizeKoreanPhoneValue(
  value: string,
): string | null {
  const digits = value.replace(/[^\d]/g, '')
  if (/^0\d{8,10}$/.test(digits)) {
    return `+82${digits.slice(1)}`
  }
  if (/^82\d{8,10}$/.test(digits)) {
    return `+${digits}`
  }
  return null
}

/** 국내 번호 일부를 E.164 저장값의 숫자 부분과 검색할 수 있게 맞춘다. */
export function koreanPhoneSearchDigits(value: string): string {
  const digits = value.replace(/[^\d]/g, '')
  if (!digits) return ''

  return digits.startsWith('0') ? `82${digits.slice(1)}` : digits
}
