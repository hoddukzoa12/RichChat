import type {
  OfficePhoneSigningKeyStatus,
} from '../shared/wire/office'
import { parseSigningKeys } from './gateway/signing-keys'

type SigningKeyConfiguration =
  | {
      available: true
      hasDefault: boolean
      deviceIds: ReadonlySet<string>
    }
  | { available: false }

/**
 * 설정 화면에는 키의 존재 여부만 필요하다. 파싱한 키 값은 반환하거나
 * 로그에 남기지 않고, 유효한 설정에서 기기 ID 집합만 만든다.
 */
export function readSigningKeyConfiguration(
  rawSigningKeys: unknown,
): SigningKeyConfiguration {
  const configuration = parseSigningKeys(rawSigningKeys)
  if (!configuration) return { available: false }

  return {
    available: true,
    hasDefault: configuration.kind === 'shared',
    deviceIds: new Set(
      configuration.kind === 'legacy'
        ? configuration.deviceKeys.keys()
        : configuration.overrides.keys(),
    ),
  }
}

export function signingKeyStatus(
  configuration: SigningKeyConfiguration,
  deviceId: string | null,
): OfficePhoneSigningKeyStatus {
  if (deviceId === null) return '해당 없음'
  if (!configuration.available) return '확인 불가'
  return (
    configuration.hasDefault ||
    configuration.deviceIds.has(deviceId)
  )
    ? '설정됨'
    : '미설정'
}
