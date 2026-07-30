import { afterEach, describe, expect, it, vi } from 'vitest'
import { permissionsForRole } from '../../../shared/permissions'
import type { MeResponse } from '../../../shared/wire/settings'
import { ApiRequestError } from '../client'
import {
  createOfficePhone,
  deployOfficePhoneSigningKey,
  getAvailableOfficePhoneDevices,
  getOfficeMembers,
  getOfficePhones,
  issueOfficePhoneEnrollmentCode,
  inviteOfficeMember,
  updateOfficePhone,
  updateOfficePhoneStatus,
  updateOfficeMember,
  updateOfficeMemberStatus,
  updateMe,
  updateMeSettings,
  updateOfficeSettings,
} from './index'

const ME_RESPONSE: MeResponse = {
  user: {
    id: 'user-1',
    name: '박상담',
    title: '상담 담당',
    email: 'sangdam@rich.kr',
    role: '관리자',
  },
  office: {
    id: 'office-1',
    name: '세무법인 리치',
    emailDomain: 'rich.kr',
  },
  settings: {
    notifyNewChat: true,
    notifyMineOnly: false,
    notifySound: true,
  },
  permissions: permissionsForRole('관리자'),
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Settings endpoints', () => {
  it('sends profile and notification patches without a client key', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(Response.json(ME_RESPONSE)),
    )
    vi.stubGlobal('fetch', fetchMock)

    await updateMe({ name: '이세무' })
    await updateMeSettings({ notifySound: false })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/me',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/me/settings',
      expect.objectContaining({ method: 'PATCH' }),
    )
    const profileBody = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    ) as Record<string, unknown>
    const settingsBody = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as Record<string, unknown>
    expect(profileBody).toEqual({ name: '이세무' })
    expect(settingsBody).toEqual({ notifySound: false })
    expect(profileBody).not.toHaveProperty('clientKey')
    expect(settingsBody).not.toHaveProperty('clientKey')
  })

  it('loads the public member shape without inventing status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            members: [
              {
                id: 'member-1',
                email: 'member@rich.kr',
                name: '일반 직원',
                title: '상담 담당',
                role: '상담 담당',
              },
            ],
          }),
        ),
      ),
    )

    const { members } = await getOfficeMembers()

    expect(members).toHaveLength(1)
    expect(members[0]).not.toHaveProperty('status')
  })

  it('uses the office-phone routes without sending secret material', async () => {
    const phone = {
      id: 'phone/1',
      value: '01056129001',
      label: '업무폰 1',
      deviceId: 'android-device-1',
      isDefault: false,
      active: true,
      signingKeyStatus: '설정됨' as const,
    }
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          Response.json(
            String(input).endsWith('/phones')
              ? { phones: [phone] }
              : { phone },
          ),
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getOfficePhones()
    await issueOfficePhoneEnrollmentCode()
    await getAvailableOfficePhoneDevices()
    await deployOfficePhoneSigningKey()
    await createOfficePhone({
      value: phone.value,
      label: phone.label,
      deviceId: phone.deviceId,
    })
    await updateOfficePhone(phone.id, { label: '상담실' })
    await updateOfficePhoneStatus(phone.id, { active: false })

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      '/api/office/phones',
      '/api/office/phones/enrollment-code',
      '/api/office/phones/available-devices',
      '/api/office/phones/signing-key',
      '/api/office/phones',
      '/api/office/phones/phone%2F1',
      '/api/office/phones/phone%2F1/status',
    ])
    expect(
      JSON.parse(String(fetchMock.mock.calls[4][1]?.body)),
    ).toEqual({
      value: phone.value,
      label: phone.label,
      deviceId: phone.deviceId,
    })
    expect(
      JSON.stringify(fetchMock.mock.calls.map((call) => call[1])),
    ).not.toContain('test-sms-gateway-signing-key')
  })

  it('surfaces the server error for a malformed invite email', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: 'BAD_REQUEST',
                message: '올바른 이메일 주소가 필요합니다.',
              },
            },
            { status: 400 },
          ),
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      inviteOfficeMember({
        email: '@x.com',
        name: '초대 직원',
        title: '상담원',
        role: '상담 담당',
      }),
    ).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
      message: '올바른 이메일 주소가 필요합니다.',
    } satisfies Partial<ApiRequestError>)

    const body = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    ) as Record<string, unknown>
    expect(body).toEqual({
      email: '@x.com',
      name: '초대 직원',
      title: '상담원',
      role: '상담 담당',
    })
  })

  it('sends member edits to the encoded member route', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          Response.json({
            member: {
              id: 'member/1',
              email: 'member@rich.kr',
              name: '김세무',
              title: '세무사',
              role: '세무사',
              status: '활성',
            },
          }),
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await updateOfficeMember('member/1', {
      name: '김세무',
      title: '세무사',
      role: '세무사',
    })

    expect(response.member).toMatchObject({
      name: '김세무',
      title: '세무사',
      role: '세무사',
      status: '활성',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/office/members/member%2F1',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(
      JSON.parse(String(fetchMock.mock.calls[0][1]?.body)),
    ).toEqual({
      name: '김세무',
      title: '세무사',
      role: '세무사',
    })
  })

  it('surfaces a rejected member status transition', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: 'CONFLICT',
                message: '마지막 활성 관리자는 비활성화할 수 없습니다.',
              },
            },
            { status: 409 },
          ),
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      updateOfficeMemberStatus('admin-1', { status: '비활성' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: '마지막 활성 관리자는 비활성화할 수 없습니다.',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/office/members/admin-1/status',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(
      JSON.parse(String(fetchMock.mock.calls[0][1]?.body)),
    ).toEqual({ status: '비활성' })
  })

  it('passes invalid retention values to server validation', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: 'BAD_REQUEST',
                message: '보존 기간을 확인해 주세요.',
              },
            },
            { status: 400 },
          ),
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      updateOfficeSettings({ retentionYears: 0 }),
    ).rejects.toMatchObject({
      status: 400,
      message: '보존 기간을 확인해 주세요.',
    })
    const body = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    ) as Record<string, unknown>
    expect(body).toEqual({ retentionYears: 0 })
  })
})
