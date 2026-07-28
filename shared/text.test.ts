import { describe, expect, it } from 'vitest'
import { initialOf } from './text'

describe('initialOf', () => {
  it('빈 문자열이면 빈 문자열을 반환한다', () => {
    expect(initialOf('')).toBe('')
  })

  it('이름의 첫 글자를 반환한다', () => {
    expect(initialOf('박상담')).toBe('박')
  })
})
