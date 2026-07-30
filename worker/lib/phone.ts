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
