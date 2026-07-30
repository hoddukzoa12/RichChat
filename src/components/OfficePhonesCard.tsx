import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'
import {
  createOfficePhone,
  getOfficePhones,
  OFFICE_PHONE_DEVICE_ID_MAX_LENGTH,
  OFFICE_PHONE_LABEL_MAX_LENGTH,
  OFFICE_PHONE_VALUE_MAX_LENGTH,
  OFFICE_PHONE_VALUE_MIN_LENGTH,
  updateOfficePhone,
  updateOfficePhoneStatus,
  type OfficePhone,
} from '../api/endpoints'
import {
  MEMBER_STATUS_VIEW,
  OFFICE_PHONE_SIGNING_KEY_VIEW,
} from '../theme'
import { Card } from './ui'

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function replacePhone(
  phones: readonly OfficePhone[],
  saved: OfficePhone,
): OfficePhone[] {
  const index = phones.findIndex((phone) => phone.id === saved.id)
  if (index === -1) return [...phones, saved]

  return phones.map((phone) =>
    phone.id === saved.id ? saved : phone,
  )
}

function AddOfficePhoneModal({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: (phone: OfficePhone) => void
}) {
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const response = await createOfficePhone({
        value,
        label,
        deviceId,
      })
      onAdded(response.phone)
    } catch (failure: unknown) {
      setError(
        errorMessage(failure, '업무폰을 추가하지 못했습니다.'),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[80] bg-ink/45"
        onClick={onClose}
      />
      <form
        onSubmit={(event) => void save(event)}
        className="fixed z-[90] top-1/2 left-1/2 w-[480px] max-w-[calc(100%-32px)] max-h-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-[22px] shadow-[0_24px_56px_rgba(16,24,40,.3)]"
      >
        <div className="flex items-center">
          <span className="text-[17px] font-bold tracking-[-0.3px]">
            업무폰 추가
          </span>
          <button
            type="button"
            aria-label="업무폰 추가 닫기"
            onClick={onClose}
            className="ml-auto text-[17px] text-ink-400"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 mb-[18px] text-[13px] leading-relaxed text-ink-400">
          Android SMS Gateway에 표시된 전화번호와 Device ID를
          등록합니다.
        </p>

        <label className="block">
          <span className="mb-[7px] block text-[12.5px] font-semibold text-ink-700">
            전화번호
          </span>
          <input
            required
            inputMode="numeric"
            pattern={`[0-9]{${OFFICE_PHONE_VALUE_MIN_LENGTH},${OFFICE_PHONE_VALUE_MAX_LENGTH}}`}
            minLength={OFFICE_PHONE_VALUE_MIN_LENGTH}
            maxLength={OFFICE_PHONE_VALUE_MAX_LENGTH}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="01056129001"
            aria-describedby="office-phone-value-help"
            className="w-full rounded-[9px] border border-line-strong px-3 py-2.5 text-sm text-ink outline-none focus:border-brand"
          />
          <span
            id="office-phone-value-help"
            className="mt-1.5 block text-xs text-ink-400"
          >
            기존 발신번호와 같은 형식으로 하이픈 없이 숫자만 입력해
            주세요.
          </span>
        </label>

        <label className="mt-4 block">
          <span className="mb-[7px] block text-[12.5px] font-semibold text-ink-700">
            라벨
          </span>
          <input
            required
            maxLength={OFFICE_PHONE_LABEL_MAX_LENGTH}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="업무폰 2"
            className="w-full rounded-[9px] border border-line-strong px-3 py-2.5 text-sm text-ink outline-none focus:border-brand"
          />
        </label>

        <label className="mt-4 block">
          <span className="mb-[7px] block text-[12.5px] font-semibold text-ink-700">
            Device ID
          </span>
          <input
            required
            maxLength={OFFICE_PHONE_DEVICE_ID_MAX_LENGTH}
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            placeholder="Android SMS Gateway Device ID"
            className="w-full rounded-[9px] border border-line-strong px-3 py-2.5 font-mono text-[13px] text-ink outline-none focus:border-brand"
          />
        </label>

        <div className="mt-4 rounded-[10px] bg-doing-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-doing-fg">
          Device ID를 바꾸면 Worker의 서명키 시크릿도 함께 갱신해야
          합니다. 기기를 교체할 때는 새 업무폰을 추가한 뒤 기존
          업무폰을 비활성화해 주세요.
        </div>

        {error && (
          <div
            role="alert"
            className="mt-3 rounded-lg bg-open-bg px-3 py-2 text-[12.5px] text-open-fg"
          >
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="flex h-9 items-center rounded-[9px] border border-line-strong px-3.5 text-[13.5px] font-medium text-ink-600"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex h-9 items-center rounded-[9px] bg-brand px-4 text-[13.5px] font-semibold text-white hover:bg-brand-hover disabled:bg-line-soft"
          >
            {saving ? '추가 중…' : '추가'}
          </button>
        </div>
      </form>
    </>
  )
}

export function OfficePhonesCard() {
  const [phones, setPhones] = useState<OfficePhone[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    getOfficePhones(controller.signal)
      .then(({ phones: loaded }) => setPhones(loaded))
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setError(
          errorMessage(
            failure,
            '업무폰 목록을 불러오지 못했습니다.',
          ),
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  const saveLabel = async (phone: OfficePhone) => {
    setPendingId(phone.id)
    setError(null)
    try {
      const { phone: saved } = await updateOfficePhone(phone.id, {
        label: labelDraft,
      })
      setPhones((current) => replacePhone(current, saved))
      setEditingId(null)
    } catch (failure: unknown) {
      setError(
        errorMessage(failure, '업무폰 라벨을 저장하지 못했습니다.'),
      )
    } finally {
      setPendingId(null)
    }
  }

  const changeStatus = async (phone: OfficePhone) => {
    setPendingId(phone.id)
    setError(null)
    try {
      const { phone: saved } = await updateOfficePhoneStatus(
        phone.id,
        { active: !phone.active },
      )
      setPhones((current) => replacePhone(current, saved))
    } catch (failure: unknown) {
      setError(
        errorMessage(
          failure,
          `${phone.label} 상태를 변경하지 못했습니다.`,
        ),
      )
    } finally {
      setPendingId(null)
    }
  }

  return (
    <>
      <Card className="p-[18px]">
        <div className="flex items-start gap-3">
          <span className="min-w-0">
            <span className="block text-sm font-bold">
              업무폰 · 문자 연동
            </span>
            <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-400">
              LGU+ 대표번호와 Android SMS Gateway 업무폰을 관리합니다.
            </span>
          </span>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="ml-auto flex-none text-[12.5px] font-semibold text-brand"
          >
            ＋ 업무폰 추가
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-danger-border bg-open-bg px-3 py-2 text-[12.5px] text-open-fg"
          >
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-8 text-center text-[13px] text-ink-400">
            업무폰 목록을 불러오고 있습니다.
          </div>
        ) : (
          <div className="mt-3.5 flex flex-col gap-[9px]">
            {phones.map((phone) => {
              const statusView =
                MEMBER_STATUS_VIEW[
                  phone.active ? '활성' : '비활성'
                ]
              const signingKeyView =
                OFFICE_PHONE_SIGNING_KEY_VIEW[
                  phone.signingKeyStatus
                ]
              const editing = editingId === phone.id
              const pending = pendingId === phone.id
              const blocksDeactivation =
                phone.isDefault && phone.active

              return (
                <div
                  key={phone.id}
                  className={`rounded-[10px] border border-line px-[13px] py-3 ${statusView.rowClass}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {editing ? (
                      <input
                        autoFocus
                        required
                        maxLength={OFFICE_PHONE_LABEL_MAX_LENGTH}
                        value={labelDraft}
                        onChange={(event) =>
                          setLabelDraft(event.target.value)
                        }
                        aria-label={`${phone.value} 라벨`}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong px-2.5 text-[13.5px] font-semibold outline-none focus:border-brand"
                      />
                    ) : (
                      <span className="text-[13.5px] font-semibold">
                        {phone.label}
                      </span>
                    )}
                    {phone.isDefault && (
                      <span className="rounded-[5px] bg-brand-50 px-2 py-0.5 text-[11.5px] font-semibold text-brand">
                        기본 발신번호
                      </span>
                    )}
                    <span
                      className={`rounded-[5px] px-2 py-0.5 text-[11.5px] font-semibold ${statusView.badgeClass}`}
                    >
                      {statusView.label}
                    </span>
                    <span
                      className={`rounded-[5px] px-2 py-0.5 text-[11.5px] font-semibold ${signingKeyView.badgeClass}`}
                    >
                      {signingKeyView.label}
                    </span>
                  </div>

                  <div className="mt-2 grid gap-1 text-xs text-ink-500 sm:grid-cols-[110px_minmax(0,1fr)]">
                    <span className="text-ink-400">전화번호</span>
                    <span className="font-medium text-ink-700">
                      {phone.value}
                    </span>
                    <span className="text-ink-400">Device ID</span>
                    <code className="break-all font-mono text-[11.5px] text-ink-600">
                      {phone.deviceId ?? '없음 (LGU+ 대표번호)'}
                    </code>
                  </div>

                  <div className="mt-3 flex justify-end gap-3 border-t border-fill pt-2.5">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setEditingId(null)}
                          className="text-[12.5px] text-ink-500 disabled:text-ink-300"
                        >
                          취소
                        </button>
                        <button
                          type="button"
                          disabled={
                            pending || labelDraft.trim() === ''
                          }
                          onClick={() => void saveLabel(phone)}
                          className="text-[12.5px] font-semibold text-brand disabled:text-ink-300"
                        >
                          {pending ? '저장 중…' : '저장'}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            setEditingId(phone.id)
                            setLabelDraft(phone.label)
                            setError(null)
                          }}
                          className="text-[12.5px] font-semibold text-brand disabled:text-ink-300"
                        >
                          라벨 수정
                        </button>
                        <button
                          type="button"
                          disabled={pending || blocksDeactivation}
                          title={
                            blocksDeactivation
                              ? '기본 발신번호는 비활성화할 수 없습니다.'
                              : undefined
                          }
                          onClick={() => void changeStatus(phone)}
                          className="text-[12.5px] text-ink-500 disabled:cursor-not-allowed disabled:text-ink-300"
                        >
                          {pending
                            ? '처리 중…'
                            : phone.active
                              ? '비활성화'
                              : '재활성화'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}

            {phones.length === 0 && (
              <div className="py-8 text-center text-[13px] text-ink-400">
                등록된 업무폰이 없습니다.
              </div>
            )}
          </div>
        )}

        <div className="mt-3 rounded-[10px] bg-surface-sunken px-3 py-2.5 text-[12px] leading-relaxed text-ink-500">
          Device ID는 등록 후 수정하지 않습니다. 기기 교체 시 새
          업무폰을 추가하고 서명키 시크릿을 갱신한 뒤 기존 업무폰을
          비활성화하세요.
        </div>
      </Card>

      {addOpen && (
        <AddOfficePhoneModal
          onClose={() => setAddOpen(false)}
          onAdded={(phone) => {
            setPhones((current) => replacePhone(current, phone))
            setAddOpen(false)
          }}
        />
      )}
    </>
  )
}
