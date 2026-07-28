import type { Role } from '../../types'
import { apiRequest } from '../client'

export interface MeResponse {
  user: {
    id: string
    name: string
    title: string
    email: string
    role: Role
  }
  office: {
    id: string
    name: string
    emailDomain: string | null
  }
  settings: {
    notifyNewChat: boolean
    notifyMineOnly: boolean
    notifySound: boolean
  }
  isAdmin: boolean
}

export function getMe(signal?: AbortSignal): Promise<MeResponse> {
  return apiRequest('/api/me', { signal })
}
