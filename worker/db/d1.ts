export class D1BatchError extends Error {
  constructor(cause: unknown) {
    super('D1 batch 실행에 실패했습니다.', { cause })
    this.name = 'D1BatchError'
  }
}

/** 성공 여부를 해석하지 않고 D1이 보고한 변경 행 수만 반환한다. */
export function changes(result: D1Result): number {
  return result.meta.changes
}

/**
 * 모든 문장을 D1의 단일 batch로 실행한다.
 * 실패한 문장을 개별 재시도하지 않으므로 D1의 전체 롤백 성질을 보존한다.
 */
export async function executeBatch<T = unknown>(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  try {
    return await db.batch<T>([...statements])
  } catch (cause) {
    throw new D1BatchError(cause)
  }
}
