import { apiRequest } from './client'

interface DevelopmentLoginResponse {
  ok: true
  expiresAt: number
}

export function developmentLogin(): Promise<DevelopmentLoginResponse> {
  return apiRequest('/api/dev/login', { method: 'POST' })
}
