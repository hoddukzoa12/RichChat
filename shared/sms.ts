export const SMS_MAX_BYTES = 90
export const LMS_MAX_BYTES = 2000
export const LMS_TITLE_MAX_BYTES = 40

const EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u

/** EUC-KR 기준 바이트 길이. ASCII 1, 그 외 2. UTF-8이 아니다. */
export function smsByteLength(text: string): number {
  let n = 0
  for (const ch of text) n += ch.codePointAt(0)! < 0x80 ? 1 : 2
  return n
}

export type MessageType = 'SMS' | 'LMS' | 'TOO_LONG'

/** 본문 길이에 맞는 LGU+ 문자 메시지 타입을 고른다. */
export function pickMessageType(text: string): MessageType {
  const n = smsByteLength(text)
  return n <= SMS_MAX_BYTES ? 'SMS' : n <= LMS_MAX_BYTES ? 'LMS' : 'TOO_LONG'
}

/** CP949에서 표현할 수 없는 이모지가 포함되어 있는지 판별한다. */
export function containsEmoji(text: string): boolean {
  return EMOJI_PATTERN.test(text)
}
