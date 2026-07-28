import { apiRequest } from '../client'

export function logout(): Promise<void> {
  return apiRequest('/api/auth/logout', { method: 'POST' })
}
