import type { ConversationListCustomer } from '../../shared/wire/conversation'

export function maskedPhone(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, '')
  const local =
    digits.startsWith('82') && digits.length === 12
      ? `0${digits.slice(2)}`
      : digits
  if (local.length < 8) return phoneE164
  return `${local.slice(0, 3)}-****-${local.slice(-4)}`
}

/**
 * 수신과 함께 자동 생성된 고객은 이름이 전화번호와 같다.
 * 목록과 데스크톱 알림이 같은 표시명을 쓰도록 여기서 한 번만 판정한다.
 */
export function customerDisplayName(
  customer: Pick<ConversationListCustomer, 'name' | 'phoneE164'>,
): string {
  return customer.name === customer.phoneE164
    ? maskedPhone(customer.phoneE164)
    : customer.name
}
