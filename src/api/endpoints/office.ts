import type {
  OfficeInviteRequest,
  OfficeInviteResponse,
  OfficeMemberPatch,
  OfficeMemberResponse,
  OfficeMemberStatusPatch,
  OfficeMembersResponse,
  OfficePhoneCreate,
  OfficePhonePatch,
  OfficePhoneResponse,
  OfficePhonesResponse,
  OfficePhoneStatusPatch,
  OfficeSettingsPatch,
  OfficeSettingsResponse,
} from '../../../shared/wire/office'
import { apiRequest } from '../client'
import { jsonMutation } from './jsonMutation'

export type {
  MemberStatus,
  OfficeInviteRequest,
  OfficeInviteResponse,
  OfficeMember,
  OfficeMemberPatch,
  OfficeMemberResponse,
  OfficeMemberStatusPatch,
  OfficeMembersResponse,
  OfficeMemberWithStatus,
  OfficePhone,
  OfficePhoneCreate,
  OfficePhonePatch,
  OfficePhoneResponse,
  OfficePhonesResponse,
  OfficePhoneSigningKeyStatus,
  OfficePhoneStatusPatch,
  OfficeSettings,
  OfficeSettingsPatch,
  OfficeSettingsResponse,
} from '../../../shared/wire/office'
export {
  OFFICE_PHONE_DEVICE_ID_MAX_LENGTH,
  OFFICE_PHONE_LABEL_MAX_LENGTH,
  OFFICE_PHONE_VALUE_MAX_LENGTH,
  OFFICE_PHONE_VALUE_MIN_LENGTH,
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

export function getOfficePhones(
  signal?: AbortSignal,
): Promise<OfficePhonesResponse> {
  return apiRequest('/api/office/phones', { signal })
}

export function createOfficePhone(
  phone: OfficePhoneCreate,
  signal?: AbortSignal,
): Promise<OfficePhoneResponse> {
  return jsonMutation(
    '/api/office/phones',
    'POST',
    { ...phone },
    signal,
  )
}

export function updateOfficePhone(
  phoneId: string,
  patch: OfficePhonePatch,
  signal?: AbortSignal,
): Promise<OfficePhoneResponse> {
  return jsonMutation(
    `/api/office/phones/${encodeURIComponent(phoneId)}`,
    'PATCH',
    { ...patch },
    signal,
  )
}

export function updateOfficePhoneStatus(
  phoneId: string,
  patch: OfficePhoneStatusPatch,
  signal?: AbortSignal,
): Promise<OfficePhoneResponse> {
  return jsonMutation(
    `/api/office/phones/${encodeURIComponent(phoneId)}/status`,
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

export function updateOfficeMember(
  memberId: string,
  patch: OfficeMemberPatch,
  signal?: AbortSignal,
): Promise<OfficeMemberResponse> {
  return jsonMutation(
    `/api/office/members/${encodeURIComponent(memberId)}`,
    'PATCH',
    { ...patch },
    signal,
  )
}

export function updateOfficeMemberStatus(
  memberId: string,
  patch: OfficeMemberStatusPatch,
  signal?: AbortSignal,
): Promise<OfficeMemberResponse> {
  return jsonMutation(
    `/api/office/members/${encodeURIComponent(memberId)}/status`,
    'PATCH',
    { ...patch },
    signal,
  )
}
