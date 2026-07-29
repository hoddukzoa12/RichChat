import type { Role } from '../domain'
import type { PermissionSet } from '../permissions'

export const ME_PROFILE_FIELDS = ['name'] as const
export const USER_SETTING_FIELDS = [
  'notifyNewChat',
  'notifyMineOnly',
  'notifySound',
] as const
export const USER_SETTING_INPUTS = [
  [true, 1],
  [false, 0],
  ['true', 1],
  ['false', 0],
  [1, 1],
  [0, 0],
] as const

export type MeProfileField = (typeof ME_PROFILE_FIELDS)[number]
export type UserSettingField = (typeof USER_SETTING_FIELDS)[number]
export type UserSettingInput =
  (typeof USER_SETTING_INPUTS)[number][0]

export type UpdateMeRequest = Partial<Record<MeProfileField, string>>
export type UpdateMeSettingsRequest = Partial<
  Record<UserSettingField, UserSettingInput>
>
export type UserSettings = Record<UserSettingField, boolean>

export const DEFAULT_USER_SETTINGS = {
  notifyNewChat: true,
  notifyMineOnly: false,
  notifySound: true,
} as const satisfies UserSettings

export interface MeUser {
  id: string
  name: string
  title: string
  email: string
  role: Role
}

export interface MeOffice {
  id: string
  name: string
  emailDomain: string | null
}

export interface MeResponse {
  user: MeUser
  office: MeOffice
  settings: UserSettings
  permissions: PermissionSet
}
