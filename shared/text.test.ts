import { describe, expect, it } from 'vitest'
import { initialOf } from './text'

describe('initialOf', () => {
  it('returns an empty string for an empty name', () => {
    expect(initialOf('')).toBe('')
  })

  it('returns the first character of a name', () => {
    expect(initialOf('박상담')).toBe('박')
  })
})
