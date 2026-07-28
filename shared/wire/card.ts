export interface CustomerField {
  id: string
  key: string
  value: string
  sortOrder: number
  updatedAt: number
}

export interface CustomerCard {
  id: string
  phoneE164: string
  name: string
  company: string
  roleTitle: string
  version: number
  updatedAt: number
  fields: CustomerField[]
}

export interface CustomerFieldCreate {
  key: string
  value: string
  sortOrder: number
}

export interface CustomerFieldUpdate {
  id: string
  key?: string
  value?: string
  sortOrder?: number
}

export interface CustomerFieldChanges {
  create?: CustomerFieldCreate[]
  update?: CustomerFieldUpdate[]
  delete?: string[]
}

export interface UpdateCustomerRequest {
  version: number
  name?: string
  company?: string
  roleTitle?: string
  fieldChanges?: CustomerFieldChanges
}

export interface UpdateCustomerResponse {
  customer: CustomerCard
}

export interface CustomerVersionConflictResponse {
  error: {
    code: 'CONFLICT_VERSION'
    message: string
    detail: {
      current: CustomerCard
    }
  }
}
