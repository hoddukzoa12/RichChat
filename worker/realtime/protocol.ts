export const HUB_CONNECT_URL = 'https://office-hub/connect'
export const HUB_VERIFIED_OFFICE_ID_HEADER =
  'x-richchat-verified-office-id'
export const HUB_VERIFIED_USER_ID_HEADER =
  'x-richchat-verified-user-id'

export interface ConnectionIdentity {
  officeId: string
  userId: string
}
