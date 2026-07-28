import type {
  ConversationDetailResponse,
  UpdateCustomerRequest,
  UpdateCustomerResponse,
} from '../../../shared/wire'
import { apiRequest } from '../client'
import { apiJsonRequest } from './request'

export function getConversationDetail(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationDetailResponse> {
  return apiRequest(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    { signal },
  )
}

export function updateCustomer(
  customerId: string,
  body: UpdateCustomerRequest,
  signal?: AbortSignal,
): Promise<UpdateCustomerResponse> {
  return apiJsonRequest(
    `/api/customers/${encodeURIComponent(customerId)}`,
    'PATCH',
    body,
    signal,
  )
}
