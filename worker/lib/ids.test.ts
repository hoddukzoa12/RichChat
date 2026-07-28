import { describe, expect, it } from 'vitest'
import { createUlidFactory } from './ids'

const FIXED_TIME = 1_753_670_800_123

describe('ULID generation', () => {
  it('creates 1000 unique IDs in generation order', () => {
    let time = FIXED_TIME
    const createId = createUlidFactory(() => {
      time += 1
      return time
    })
    const ids = Array.from({ length: 1_000 }, () => createId())

    expect(new Set(ids)).toHaveLength(ids.length)
    expect([...ids].sort()).toEqual(ids)
    expect(ids.every((id) => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id))).toBe(
      true,
    )
  })

  it('increments monotonically within the same millisecond', () => {
    const createId = createUlidFactory(() => FIXED_TIME)
    const ids = Array.from({ length: 1_000 }, () => createId())

    expect(new Set(ids)).toHaveLength(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  it('stays monotonic when the wall clock moves backwards', () => {
    const times = [FIXED_TIME, FIXED_TIME - 1, FIXED_TIME - 2]
    const createId = createUlidFactory(() => times.shift() ?? FIXED_TIME)
    const ids = Array.from({ length: 3 }, () => createId())

    expect([...ids].sort()).toEqual(ids)
  })

  it('rejects time values outside the ULID range', () => {
    const createId = createUlidFactory(() => -1)

    expect(() => createId()).toThrow(RangeError)
  })
})
