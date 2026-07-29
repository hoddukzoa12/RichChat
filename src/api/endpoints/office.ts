import type {
  OfficeInviteRequest,
  OfficeInviteResponse,
  OfficeMembersResponse,
  OfficeSettingsPatch,
  OfficeSettingsResponse,
} from '../../../shared/wire/office'
import { apiRequest } from '../client'
import { jsonMutation } from './jsonMutation'

export type {
  OfficeInviteRequest,
  OfficeInviteResponse,
  OfficeMember,
  OfficeMemberPatch,
  OfficeMemberResponse,
  OfficeMemberStatusPatch,
  OfficeMembersResponse,
  OfficeMemberWithStatus,
  OfficeSettings,
  OfficeSettingsPatch,
  OfficeSettingsResponse,
} from '../../../shared/wire/office'
export {
  RETENTION_YEARS_MAX,
  RETENTION_YEARS_MIN,
} from '../../../shared/wire/office'

export function getOfficeSettings(
  signal?: AbortSignal,
): Promise<OfficeSettingsResponse> {
  return apiRequest('/api/office/settings', { signal })
}

export function updateOfficeSettings(
  patch: OfficeSettingsPatch,
  signal?: AbortSignal,
): Promise<OfficeSettingsResponse> {
  return jsonMutation(
    '/api/office/settings',
    'PATCH',
    { ...patch },
    signal,
  )
}

export function getOfficeMembers(
  signal?: AbortSignal,
): Promise<OfficeMembersResponse> {
  return apiRequest('/api/office/members', { signal })
}

export function inviteOfficeMember(
  invite: OfficeInviteRequest,
  signal?: AbortSignal,
): Promise<OfficeInviteResponse> {
  return jsonMutation(
    '/api/office/invites',
    'POST',
    { ...invite },
    signal,
  )
}
