import { describe, expect, it } from 'vitest'
import type {
  OfficeMember,
  OfficeMemberWithStatus,
} from '../api/endpoints'
import { initialState, reducer } from './inbox'

const ACTIVE_MEMBER: OfficeMember = {
  id: 'member-1',
  email: 'member@rich.kr',
  name: '일반 직원',
  title: '상담 담당',
  role: '상담 담당',
}

const INVITED_MEMBER: OfficeMemberWithStatus = {
  id: 'invite-1',
  email: 'invite@rich.kr',
  name: 'invite@rich.kr',
  title: '세무사',
  role: '세무사',
  status: '초대',
}

describe('Settings state', () => {
  it('starts without seeded team members', () => {
    expect(initialState.team).toEqual([])
  })

  it('preserves the public member shape for a non-administrator', () => {
    const state = reducer(initialState, {
      type: 'loadTeam',
      members: [ACTIVE_MEMBER],
    })

    expect(state.team).toEqual([ACTIVE_MEMBER])
    expect(state.team[0]).not.toHaveProperty('status')
  })

  it('upserts a repeated invite instead of adding a duplicate', () => {
    const loaded = reducer(initialState, {
      type: 'loadTeam',
      members: [INVITED_MEMBER],
    })
    const repeated = reducer(loaded, {
      type: 'upsertTeamMember',
      member: { ...INVITED_MEMBER, role: '상담 담당' },
    })

    expect(repeated.team).toHaveLength(1)
    expect(repeated.team[0]).toMatchObject({
      email: INVITED_MEMBER.email,
      role: '상담 담당',
    })
  })
})
