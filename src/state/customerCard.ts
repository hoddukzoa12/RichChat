import { patchSelectedConversation } from './conversations'
import {
  initialCustomerCardDataState,
  reduceCustomerCardData,
  type CustomerCardDataAction,
  type CustomerCardDataState,
} from './customerCardModel'
import type { ActionHandlers, InboxState } from './inbox'

export type CustomerCardState = CustomerCardDataState

export const initialCustomerCardState: CustomerCardState = {
  ...initialCustomerCardDataState,
}

export type CustomerCardAction = {
  type: 'cardData'
  action: CustomerCardDataAction
}

export const customerCardHandlers = {
  cardData: (state, action) => {
    const reduced = reduceCustomerCardData(state, action.action) as InboxState
    if (action.action.type !== 'customerSaved') return reduced
    if (reduced.selected !== action.action.conversationId) return reduced

    const customer = action.action.customer
    return {
      ...reduced,
      convs: patchSelectedConversation(reduced, (conversation) => ({
        customer: {
          ...conversation.customer,
          name: customer.name,
          company: customer.company,
          phoneE164: customer.phoneE164,
        },
      })),
    }
  },
} satisfies ActionHandlers<InboxState, CustomerCardAction>
