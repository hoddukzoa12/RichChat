import type {
  OfficePhoneSigningKeyStatus,
} from '../shared/wire/office'

type SigningKeyConfiguration =
  | { available: true; deviceIds: ReadonlySet<string> }
  | { available: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

/**
 * 설정 화면에는 키의 존재 여부만 필요하다. 파싱한 키 값은 반환하거나
 * 로그에 남기지 않고, 유효한 설정에서 기기 ID 집합만 만든다.
 */
export function readSigningKeyConfiguration(
  rawSigningKeys: unknown,
): SigningKeyConfiguration {
  if (
    typeof rawSigningKeys !== 'string' ||
    rawSigningKeys.trim() === ''
  ) {
    return { available: false }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawSigningKeys)
  } catch {
    return { available: false }
  }

  if (!isRecord(parsed)) return { available: false }

  const entries = Object.entries(parsed)
  if (
    entries.some(
      ([deviceId, signingKey]) =>
        deviceId === '' ||
        typeof signingKey !== 'string' ||
        signingKey.length === 0,
    )
  ) {
    return { available: false }
  }

  return {
    available: true,
    deviceIds: new Set(entries.map(([deviceId]) => deviceId)),
  }
}

export function signingKeyStatus(
  configuration: SigningKeyConfiguration,
  deviceId: string | null,
): OfficePhoneSigningKeyStatus {
  if (deviceId === null) return '해당 없음'
  if (!configuration.available) return '확인 불가'
  return configuration.deviceIds.has(deviceId)
    ? '설정됨'
    : '미설정'
}
