import type {
  MeResponse,
  UpdateMeRequest,
  UpdateMeSettingsRequest,
} from '../../../shared/wire/settings'
import { apiRequest } from '../client'
import { jsonMutation } from './jsonMutation'

export type {
  MeResponse,
  UpdateMeRequest,
  UpdateMeSettingsRequest,
  UserSettingField,
  UserSettings,
} from '../../../shared/wire/settings'

export function getMe(signal?: AbortSignal): Promise<MeResponse> {
  return apiRequest('/api/me', { signal })
}

export function updateMe(
  patch: UpdateMeRequest,
  signal?: AbortSignal,
): Promise<MeResponse> {
  return jsonMutation('/api/me', 'PATCH', { ...patch }, signal)
}

export function updateMeSettings(
  patch: UpdateMeSettingsRequest,
  signal?: AbortSignal,
): Promise<MeResponse> {
  return jsonMutation('/api/me/settings', 'PATCH', { ...patch }, signal)
}
