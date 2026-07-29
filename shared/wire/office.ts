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
