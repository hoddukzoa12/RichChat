import type { Role } from './domain'

export const PERMISSIONS = [
  'team:view',
  'team:manage',
  'team:manage-administrator',
  'team:assign-administrator',
  'office:manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]
export type PermissionSet = Record<Permission, boolean>

const ROLE_PERMISSIONS: Record<
  Role,
  PermissionSet
> = {
  관리자: {
    'team:view': true,
    'team:manage': true,
    'team:manage-administrator': true,
    'team:assign-administrator': true,
    'office:manage': true,
  },
  부관리자: {
    'team:view': true,
    'team:manage': true,
    'team:manage-administrator': false,
    'team:assign-administrator': false,
    'office:manage': false,
  },
  세무사: {
    'team:view': true,
    'team:manage': false,
    'team:manage-administrator': false,
    'team:assign-administrator': false,
    'office:manage': false,
  },
  '상담 담당': {
    'team:view': true,
    'team:manage': false,
    'team:manage-administrator': false,
    'team:assign-administrator': false,
    'office:manage': false,
  },
}

export function hasPermission(
  role: Role,
  permission: Permission,
): boolean {
  return ROLE_PERMISSIONS[role][permission]
}

export function permissionsForRole(role: Role): PermissionSet {
  return { ...ROLE_PERMISSIONS[role] }
}
