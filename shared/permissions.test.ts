import { describe, expect, it } from 'vitest'
import { ROLES, type Role } from './domain'
import {
  hasPermission,
  PERMISSIONS,
  type Permission,
} from './permissions'

const EXPECTED_PERMISSIONS: Record<
  Role,
  Record<Permission, boolean>
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

describe('Role permissions', () => {
  it('answers every role and permission combination', () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        expect(hasPermission(role, permission)).toBe(
          EXPECTED_PERMISSIONS[role][permission],
        )
      }
    }
  })
})
