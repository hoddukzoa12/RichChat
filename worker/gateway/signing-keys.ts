interface LegacySigningKeys {
  kind: 'legacy'
  deviceKeys: ReadonlyMap<string, string>
}

interface SharedSigningKeys {
  kind: 'shared'
  defaultKey: string
  overrides: ReadonlyMap<string, string>
}

export type SigningKeys = LegacySigningKeys | SharedSigningKeys

const SHARED_KEYS = new Set(['default', 'overrides'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function signingKeyEntries(
  value: unknown,
): ReadonlyMap<string, string> | null {
  if (!isRecord(value)) return null

  const entries = Object.entries(value)
  if (
    entries.some(
      ([deviceId, signingKey]) =>
        deviceId === '' ||
        typeof signingKey !== 'string' ||
        signingKey.length === 0,
    )
  ) {
    return null
  }

  return new Map(entries as Array<[string, string]>)
}

export function parseSigningKeys(raw: unknown): SigningKeys | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  if (
    typeof parsed.default !== 'string' ||
    !isRecord(parsed.overrides)
  ) {
    const deviceKeys = signingKeyEntries(parsed)
    return deviceKeys ? { kind: 'legacy', deviceKeys } : null
  }
  const defaultKey = parsed.default

  if (
    Object.keys(parsed).some((key) => !SHARED_KEYS.has(key)) ||
    defaultKey.length === 0
  ) {
    return null
  }

  const overrides = signingKeyEntries(parsed.overrides ?? {})
  return overrides
    ? {
        kind: 'shared',
        defaultKey,
        overrides,
      }
    : null
}

export function signingKeyForDevice(
  configuration: SigningKeys,
  deviceId: string,
): string | null {
  if (configuration.kind === 'legacy') {
    return configuration.deviceKeys.get(deviceId) ?? null
  }
  return (
    configuration.overrides.get(deviceId) ??
    configuration.defaultKey
  )
}

/**
 * 기존 웹훅 라우트는 기기별 맵만 이해한다. 공통 키 형식일 때 요청 기기의
 * 최종 키만 레거시 맵으로 바꿔 넘겨 기존 운영 경로를 수정하지 않는다.
 */
export function legacySigningKeysForWebhook(
  raw: string,
  deviceId: string,
): string {
  const configuration = parseSigningKeys(raw)
  if (!configuration || configuration.kind === 'legacy') return raw

  const signingKey = signingKeyForDevice(configuration, deviceId)
  return JSON.stringify(
    signingKey === null ? {} : { [deviceId]: signingKey },
  )
}
