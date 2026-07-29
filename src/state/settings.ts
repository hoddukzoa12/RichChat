import type {
  OfficeMember,
  OfficeMemberWithStatus,
} from '../api/endpoints'
import type { ActionHandlers, InboxState } from './inbox'
import type { Role } from '../types'

export interface AiSettings {
  summary: boolean
  autofill: boolean
  draft: boolean
}

export interface OfficeSettings {
  aiOn: boolean
  docRead: boolean
}

export interface SettingsState {
  ai: AiSettings
  office: OfficeSettings
  team: Array<OfficeMember | OfficeMemberWithStatus>
  teamLoading: boolean
  teamError: string | null
  inviteOpen: boolean
  inviteEmail: string
  inviteName: string
  inviteTitle: string
  inviteRole: Role
}

export const initialSettingsState: SettingsState = {
  ai: { summary: true, autofill: true, draft: false },
  office: { aiOn: true, docRead: true },
  team: [],
  teamLoading: true,
  teamError: null,
  inviteOpen: false,
  inviteEmail: '',
  inviteName: '',
  inviteTitle: '',
  inviteRole: '상담 담당',
}

export type SettingsAction =
  | { type: 'toggleAi'; key: keyof AiSettings }
  | { type: 'toggleOffice'; key: keyof OfficeSettings }
  | {
      type: 'loadTeam'
      members: Array<OfficeMember | OfficeMemberWithStatus>
    }
  | { type: 'failTeam'; message: string }
  | {
      type: 'upsertTeamMember'
      member: OfficeMemberWithStatus
    }
  | { type: 'openInvite' }
  | { type: 'closeInvite' }
  | { type: 'setInviteEmail'; value: string }
  | { type: 'setInviteName'; value: string }
  | { type: 'setInviteTitle'; value: string }
  | { type: 'setInviteRole'; value: Role }

export const settingsHandlers = {
  toggleAi: (state, action) => ({
    ...state,
    ai: { ...state.ai, [action.key]: !state.ai[action.key] },
  }),

  toggleOffice: (state, action) => ({
    ...state,
    office: { ...state.office, [action.key]: !state.office[action.key] },
  }),

  loadTeam: (state, action) => ({
    ...state,
    team: action.members,
    teamLoading: false,
    teamError: null,
  }),

  failTeam: (state, action) => ({
    ...state,
    teamLoading: false,
    teamError: action.message,
  }),

  upsertTeamMember: (state, action) => {
    const exists = state.team.some(
      (member) =>
        member.id === action.member.id ||
        member.email === action.member.email,
    )
    return {
      ...state,
      team: exists
        ? state.team.map((member) =>
            member.id === action.member.id ||
            member.email === action.member.email
              ? action.member
              : member,
          )
        : [...state.team, action.member],
    }
  },

  openInvite: (state) => ({
    ...state,
    inviteOpen: true,
    inviteEmail: '',
    inviteName: '',
    inviteTitle: '',
    inviteRole: '상담 담당',
  }),

  closeInvite: (state) => ({ ...state, inviteOpen: false }),

  setInviteEmail: (state, action) => ({ ...state, inviteEmail: action.value }),

  setInviteName: (state, action) => ({ ...state, inviteName: action.value }),

  setInviteTitle: (state, action) => ({ ...state, inviteTitle: action.value }),

  setInviteRole: (state, action) => ({ ...state, inviteRole: action.value }),
} satisfies ActionHandlers<InboxState, SettingsAction>
