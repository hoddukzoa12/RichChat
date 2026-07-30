import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OfficePhone } from '../../shared/wire/office'
import { OfficePhoneSigningKeyModal } from './OfficePhonesCard'

const PHONE: OfficePhone = {
  id: 'phone-signing-key',
  value: '01056129001',
  label: '상담실 업무폰',
  deviceId: 'android-device-signing-key',
  isDefault: false,
  active: true,
  signingKeyStatus: '설정됨',
}

const handlers = {
  onIssue: vi.fn(),
  onCopy: vi.fn(),
  onClose: vi.fn(),
}

describe('Office phone signing-key modal', () => {
  it('warns before replacing an existing key', () => {
    const markup = renderToStaticMarkup(
      <OfficePhoneSigningKeyModal
        phone={PHONE}
        signingKey={null}
        issuing={false}
        copied={false}
        error={null}
        {...handlers}
      />,
    )

    expect(markup).toContain('서명키 재발급')
    expect(markup).toContain('기존 키가 즉시 무효')
    expect(markup).toContain('문자 수신이 끊깁니다')
    expect(markup).toContain('재발급하고 기존 키 무효화')
  })

  it('renders the issued key once with copy and app instructions', () => {
    const signingKey = 'a1'.repeat(32)
    const markup = renderToStaticMarkup(
      <OfficePhoneSigningKeyModal
        phone={PHONE}
        signingKey={signingKey}
        issuing={false}
        copied={false}
        error={null}
        {...handlers}
      />,
    )

    expect(markup).toContain(signingKey)
    expect(markup).toContain('>복사<')
    expect(markup).toContain('설정 → Webhooks → Signing Key')
    expect(markup).toContain('닫으면 서명키를 다시 볼 수 없습니다')
    expect(markup).toContain('서명키 발급 완료')
    expect(markup).toContain('서명키 설정됨')
  })
})
