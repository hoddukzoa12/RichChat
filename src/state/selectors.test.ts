import { describe, expect, it } from 'vitest'
import { officeChannelLabel } from './selectors'

describe('officeChannelLabel', () => {
  it('always includes the unique number when a channel exists', () => {
    expect(
      officeChannelLabel({
        id: 'channel-empty-label',
        label: '',
        value: '01011112222',
      }),
    ).toBe('01011112222')
    expect(
      officeChannelLabel({
        id: 'channel-duplicate-label-a',
        label: '상담폰',
        value: '01033334444',
      }),
    ).toBe('상담폰 · 01033334444')
    expect(
      officeChannelLabel({
        id: 'channel-duplicate-label-b',
        label: '상담폰',
        value: '01055556666',
      }),
    ).toBe('상담폰 · 01055556666')
  })

  it('labels an unassigned conversation without hiding it', () => {
    expect(officeChannelLabel(null)).toBe('업무폰 미지정')
  })
})
