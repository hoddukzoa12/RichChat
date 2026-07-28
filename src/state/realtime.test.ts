import { describe, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '../../shared/wire/event'
import {
  applyRealtimeFrame,
  RealtimeCursor,
} from './realtime'

function event(officeSeq: number): EventEnvelope {
  return {
    officeSeq,
    type: 'message.created',
    entity: 'message',
    entityId: `message-${officeSeq}`,
    conversationId: 'conversation-1',
    actorKind: 'customer',
    actorId: null,
    payload: {},
    createdAt: 1_900_000_000_000 + officeSeq,
  }
}

describe('Realtime cursor', () => {
  it('advances only after a contiguous batch is applied', async () => {
    const cursor = new RealtimeCursor()
    const controller = new AbortController()
    const apply = vi.fn(() => Promise.resolve())

    await expect(
      cursor.apply([event(1), event(2)], apply, controller.signal),
    ).resolves.toBe(true)

    expect(apply).toHaveBeenCalledWith(
      [event(1), event(2)],
      controller.signal,
    )
    expect(cursor.lastSeq).toBe(2)
  })

  it('does not apply a frame across a sequence gap', async () => {
    const cursor = new RealtimeCursor()
    const apply = vi.fn(() => Promise.resolve())

    await expect(
      cursor.apply(
        [event(2)],
        apply,
        new AbortController().signal,
      ),
    ).resolves.toBe(false)

    expect(apply).not.toHaveBeenCalled()
    expect(cursor.lastSeq).toBe(0)
  })

  it('keeps the cursor when applying server state fails', async () => {
    const cursor = new RealtimeCursor()
    const failure = new Error('reload failed')

    await expect(
      cursor.apply(
        [event(1)],
        () => Promise.reject(failure),
        new AbortController().signal,
      ),
    ).rejects.toBe(failure)

    expect(cursor.lastSeq).toBe(0)
  })

  it('catches up a skipped frame without applying it out of order', async () => {
    const cursor = new RealtimeCursor()
    const controller = new AbortController()
    const applied: number[][] = []
    const apply = async (events: readonly EventEnvelope[]) => {
      applied.push(events.map(({ officeSeq }) => officeSeq))
    }
    const catchUp = vi.fn(async (signal: AbortSignal) => {
      await cursor.apply([event(1), event(2)], apply, signal)
    })

    await applyRealtimeFrame(
      event(2),
      cursor,
      catchUp,
      apply,
      controller.signal,
    )

    expect(catchUp).toHaveBeenCalledWith(controller.signal)
    expect(applied).toEqual([[1, 2]])
    expect(cursor.lastSeq).toBe(2)
  })
})
