import type { EventEnvelope } from '../../shared/wire/event'

export type EventBatchApplier = (
  events: readonly EventEnvelope[],
  signal: AbortSignal,
) => Promise<void>

export type EventCatchup = (signal: AbortSignal) => Promise<void>

/**
 * 적용된 이벤트까지만 기억한다. 네트워크 전송 방식과 무관하게 HTTP 캐치업과
 * WebSocket 프레임이 이 커서를 함께 통과해야 한다.
 */
export class RealtimeCursor {
  #lastSeq = 0

  get lastSeq(): number {
    return this.#lastSeq
  }

  async apply(
    events: readonly EventEnvelope[],
    applyBatch: EventBatchApplier,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (
      !events.every(
        (event, index) => event.officeSeq === this.#lastSeq + index + 1,
      )
    ) {
      return false
    }
    if (events.length === 0) return true

    await applyBatch(events, signal)
    this.#lastSeq = events.at(-1)?.officeSeq ?? this.#lastSeq
    return true
  }

  reset(lastSeq: number): void {
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
      throw new TypeError('실시간 커서는 0 이상의 안전한 정수여야 합니다.')
    }
    this.#lastSeq = lastSeq
  }
}

/**
 * 연속 프레임만 직접 적용한다. 갭·중복·역순 프레임은 먼저 D1 캐치업으로
 * 확인하며, 캐치업 뒤 이미 반영된 프레임은 다시 적용하지 않는다.
 */
export async function applyRealtimeFrame(
  frame: EventEnvelope | undefined,
  cursor: RealtimeCursor,
  catchUp: EventCatchup,
  applyBatch: EventBatchApplier,
  signal: AbortSignal,
): Promise<void> {
  if (!frame || frame.officeSeq !== cursor.lastSeq + 1) {
    await catchUp(signal)
    if (!frame || frame.officeSeq <= cursor.lastSeq) return
  }

  const applied = await cursor.apply([frame], applyBatch, signal)
  if (!applied) await catchUp(signal)
}
