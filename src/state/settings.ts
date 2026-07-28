import { PROFILE, TEAM } from '../data/seed'
import type { Profile, TeamMember } from '../types'
import type { ActionHandlers, InboxState } from './inbox'

export interface NotifySettings {
  newChat: boolean
  mineOnly: boolean
  sound: boolean
}

export interface AiSettings {
  summary: boolean
  autofill: boolean
  draft: boolean
}

export interface OfficeSettings {
  aiOn: boolean
  docRead: boolean
  exportLog: boolean
}

export interface SettingsState {
  profile: Profile
  notify: NotifySettings
  ai: AiSettings
  office: OfficeSettings
  isAdmin: boolean
  team: TeamMember[]
  inviteOpen: boolean
  inviteEmail: string
  inviteRole: string
}

export const initialSettingsState: SettingsState = {
  profile: PROFILE,
  notify: { newChat: true, mineOnly: false, sound: true },
  ai: { summary: true, autofill: true, draft: false },
  office: { aiOn: true, docRead: true, exportLog: false },
  isAdmin: true,
  team: TEAM,
  inviteOpen: false,
  inviteEmail: '',
  inviteRole: '상담 담당',
}

export type SettingsAction =
  | { type: 'setProfile'; key: keyof Profile; value: string }
  | { type: 'toggleNotify'; key: keyof NotifySettings }
  | { type: 'toggleAi'; key: keyof AiSettings }
  | { type: 'toggleOffice'; key: keyof OfficeSettings }
  | { type: 'openInvite' }
  | { type: 'closeInvite' }
  | { type: 'setInviteEmail'; value: string }
  | { type: 'setInviteRole'; value: string }
  | { type: 'sendInvite' }

export const settingsHandlers = {
  setProfile: (state, action) => ({
    ...state,
    profile: { ...state.profile, [action.key]: action.value },
  }),

  toggleNotify: (state, action) => ({
    ...state,
    notify: { ...state.notify, [action.key]: !state.notify[action.key] },
  }),

  toggleAi: (state, action) => ({
    ...state,
    ai: { ...state.ai, [action.key]: !state.ai[action.key] },
  }),

  toggleOffice: (state, action) => ({
    ...state,
    office: { ...state.office, [action.key]: !state.office[action.key] },
  }),

  openInvite: (state) => ({
    ...state,
    inviteOpen: true,
    inviteEmail: '',
    inviteRole: '상담 담당',
  }),

  closeInvite: (state) => ({ ...state, inviteOpen: false }),

  setInviteEmail: (state, action) => ({ ...state, inviteEmail: action.value }),

  setInviteRole: (state, action) => ({ ...state, inviteRole: action.value }),

  sendInvite: (state) => {
    const email = state.inviteEmail.trim()
    if (!email) return state
    const nick = email.split('@')[0]
    return {
      ...state,
      inviteOpen: false,
      team: [
        ...state.team,
        {
          name: nick,
          initial: nick[0].toUpperCase(),
          email,
          role: state.inviteRole,
          pending: true,
        },
      ],
    }
  },
} satisfies ActionHandlers<InboxState, SettingsAction>
