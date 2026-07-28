import {
  ROLES,
  type Role,
  type UserStatus,
} from '../domain'

export const RETENTION_YEARS_MIN = 1
export const RETENTION_YEARS_MAX = 100

type AdministratorRole = (typeof ROLES)[0]

export type InviteRole = Exclude<Role, AdministratorRole>

export const INVITE_ROLES: readonly InviteRole[] = ROLES.filter(
  (role): role is InviteRole => role !== ROLES[0],
)

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
  role: InviteRole
}

export interface OfficeInviteResponse {
  member: OfficeMemberWithStatus
}
