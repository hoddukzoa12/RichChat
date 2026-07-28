import { describe, expect, it } from 'vitest'
import { canonicalizeEmail } from './email'

describe('canonicalizeEmail', () => {
  it('normalizes surrounding whitespace and ASCII case', () => {
    expect(canonicalizeEmail('  Invitee@Rich.Example \n')).toBe(
      'invitee@rich.example',
    )
  })
})
