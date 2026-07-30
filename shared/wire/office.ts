import type { Role, UserStatus } from '../domain'

export const RETENTION_YEARS_MIN = 1
export const RETENTION_YEARS_MAX = 100
export const MEMBER_STATUS_VALUES = ['활성', '비활성'] as const satisfies
  readonly UserStatus[]
export type MemberStatus = (typeof MEMBER_STATUS_VALUES)[number]

export interface OfficeSettings {
  exportLog: boolean
  retentionYears: number
  updatedAt: number
  updatedBy: string | null
}

export interface OfficeSettingsResponse {
  settings: OfficeSettings
}

export interface OfficeSettingsPatch {
  exportLog?: boolean
  retentionYears?: number
}

export interface OfficeMember {
  id: string
  email: string
  name: string
  title: string
  role: Role
}

export interface OfficeMemberWithStatus extends OfficeMember {
  status: UserStatus
}

export interface OfficeMembersResponse {
  members: Array<OfficeMember | OfficeMemberWithStatus>
}

export interface OfficeInviteRequest {
  email: string
  name: string
  title: string
  role: Role
}

export interface OfficeMemberResponse {
  member: OfficeMemberWithStatus
}

export type OfficeInviteResponse = OfficeMemberResponse

export interface OfficeMemberPatch {
  name?: string
  title?: string
  role?: Role
}

export interface OfficeMemberStatusPatch {
  status: MemberStatus
}

export const OFFICE_PHONE_VALUE_MIN_LENGTH = 8
export const OFFICE_PHONE_VALUE_MAX_LENGTH = 11
export const OFFICE_PHONE_LABEL_MAX_LENGTH = 100
export const OFFICE_PHONE_DEVICE_ID_MAX_LENGTH = 200

export const OFFICE_PHONE_SIGNING_KEY_STATUSES = [
  '설정됨',
  '미설정',
  '해당 없음',
] as const
export type OfficePhoneSigningKeyStatus =
  (typeof OFFICE_PHONE_SIGNING_KEY_STATUSES)[number]

export interface OfficePhone {
  id: string
  value: string
  label: string
  deviceId: string | null
  isDefault: boolean
  active: boolean
  signingKeyStatus: OfficePhoneSigningKeyStatus
}

export interface OfficePhonesResponse {
  phones: OfficePhone[]
}

export interface OfficePhoneResponse {
  phone: OfficePhone
}

export interface OfficePhoneSigningKeyResponse {
  phone: OfficePhone
  signingKey: string
}

export interface OfficePhoneCreate {
  value: string
  label: string
  deviceId: string
}

export interface OfficePhonePatch {
  label: string
}

export interface OfficePhoneStatusPatch {
  active: boolean
}

export interface OfficePhoneEnrollmentCode {
  apiUrl: string
  code: string
  validUntil: string
}

export interface OfficePhoneEnrollmentCodeResponse {
  enrollment: OfficePhoneEnrollmentCode
}

export interface OfficePhoneAvailableDevice {
  deviceId: string
  name: string
}

export interface OfficePhoneAvailableDevicesResponse {
  devices: OfficePhoneAvailableDevice[]
}
