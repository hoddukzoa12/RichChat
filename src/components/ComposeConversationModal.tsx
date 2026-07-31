import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import type {
  ConversationListCustomer,
  ConversationListItem,
  ConversationOfficeChannel,
} from '../../shared/wire/conversation'
import {
  getConversationComposeOptions,
  startConversation,
} from '../api/endpoints'

const SEARCH_DEBOUNCE_MS = 250

function failureMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : '새 대화를 열지 못했습니다.'
}

function phoneLabel(phone: ConversationOfficeChannel): string {
  const label = phone.label.trim()
  return label ? `${label} · ${phone.value}` : phone.value
}

export function ComposeConversationModal({
  onClose,
  onStarted,
}: {
  onClose: () => void
  onStarted: (conversation: ConversationListItem) => void
}) {
  const recipientRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [phones, setPhones] = useState<ConversationOfficeChannel[]>([])
  const [customers, setCustomers] = useState<ConversationListCustomer[]>([])
  const [selectedPhoneId, setSelectedPhoneId] = useState('')
  const [selectedCustomer, setSelectedCustomer] =
    useState<ConversationListCustomer | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    recipientRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      void getConversationComposeOptions(query, controller.signal)
        .then((response) => {
          setPhones(response.phones)
          setCustomers(response.customers)
          setSelectedPhoneId((current) =>
            response.phones.some(({ id }) => id === current)
              ? current
              : response.phones.length === 1
                ? response.phones[0].id
                : '',
          )
          setError(null)
        })
        .catch((failure: unknown) => {
          if (controller.signal.aborted) return
          setError(failureMessage(failure))
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, query === '' ? 0 : SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedPhoneId) {
      setError('보내는 업무폰을 선택해 주세요.')
      return
    }
    if (!selectedCustomer && query.trim() === '') {
      setError('받는 사람의 이름이나 전화번호를 입력해 주세요.')
      return
    }

    setStarting(true)
    setError(null)
    try {
      const conversation = await startConversation(
        selectedCustomer
          ? {
              officeChannelId: selectedPhoneId,
              customerId: selectedCustomer.id,
            }
          : {
              officeChannelId: selectedPhoneId,
              phone: query.trim(),
            },
      )
      onStarted(conversation)
    } catch (failure: unknown) {
      setError(failureMessage(failure))
    } finally {
      setStarting(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[80] bg-ink/45"
        onClick={onClose}
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-conversation-title"
        onSubmit={(event) => void submit(event)}
        className="fixed z-[90] top-1/2 left-1/2 w-[460px] max-w-[calc(100%-32px)] max-h-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-[22px] shadow-[0_24px_56px_rgba(16,24,40,.3)]"
      >
        <div className="flex items-center">
          <h2
            id="compose-conversation-title"
            className="text-[17px] font-bold tracking-[-0.3px]"
          >
            새 메시지
          </h2>
          <button
            type="button"
            aria-label="새 메시지 닫기"
            onClick={onClose}
            className="ml-auto text-[17px] text-ink-400"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 mb-[18px] text-[13px] leading-relaxed text-ink-400">
          보내는 폰과 받는 사람을 고르면 대화가 열립니다.
        </p>

        <fieldset>
          <legend className="mb-2 text-[12.5px] font-bold text-ink-600">
            보내는 폰
          </legend>
          {phones.length === 1 ? (
            <div className="rounded-[10px] border border-brand-200 bg-brand-50 px-3 py-2.5 text-[13.5px] font-semibold text-ink-700">
              {phoneLabel(phones[0])}
            </div>
          ) : (
            <div className="grid gap-2">
              {phones.map((phone) => (
                <label
                  key={phone.id}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13.5px] ${
                    selectedPhoneId === phone.id
                      ? 'border-brand bg-brand-50 font-semibold'
                      : 'border-line-strong bg-white'
                  }`}
                >
                  <input
                    type="radio"
                    name="compose-phone"
                    value={phone.id}
                    checked={selectedPhoneId === phone.id}
                    onChange={() => setSelectedPhoneId(phone.id)}
                    className="accent-brand"
                  />
                  {phoneLabel(phone)}
                </label>
              ))}
            </div>
          )}
          {!loading && phones.length === 0 && (
            <div
              role="alert"
              className="rounded-[10px] border border-open-bg bg-open-bg px-3 py-2.5 text-[12.5px] text-open-fg"
            >
              발송할 수 있는 활성 업무폰이 없습니다.
            </div>
          )}
        </fieldset>

        <div className="mt-[18px]">
          <label
            htmlFor="compose-recipient"
            className="mb-2 block text-[12.5px] font-bold text-ink-600"
          >
            받는 사람
          </label>
          <input
            ref={recipientRef}
            id="compose-recipient"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedCustomer(null)
            }}
            placeholder="고객 이름 또는 010-1234-5678"
            autoComplete="off"
            className="h-10 w-full rounded-[9px] border border-line-strong bg-white px-3 text-[13.5px] text-ink outline-none focus:border-brand"
          />

          {selectedCustomer ? (
            <div className="mt-2 rounded-[10px] border border-brand-200 bg-brand-50 px-3 py-2.5">
              <div className="text-[13.5px] font-bold">
                {selectedCustomer.name}
              </div>
              <div className="mt-0.5 text-[12px] text-ink-500">
                {selectedCustomer.phoneE164}
                {selectedCustomer.company
                  ? ` · ${selectedCustomer.company}`
                  : ''}
              </div>
            </div>
          ) : (
            query.trim() !== '' && (
              <div className="mt-2 max-h-[180px] overflow-y-auto rounded-[10px] border border-line bg-white p-1.5">
                {loading ? (
                  <div className="px-2.5 py-3 text-center text-xs text-ink-400">
                    고객을 찾는 중입니다.
                  </div>
                ) : customers.length > 0 ? (
                  customers.map((customer) => (
                    <button
                      key={customer.id}
                      type="button"
                      onClick={() => {
                        setSelectedCustomer(customer)
                        setQuery(customer.name)
                      }}
                      className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-fill"
                    >
                      <span className="block text-[13.5px] font-semibold">
                        {customer.name}
                      </span>
                      <span className="block text-[12px] text-ink-400">
                        {customer.phoneE164}
                        {customer.company
                          ? ` · ${customer.company}`
                          : ''}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-2.5 py-3 text-xs leading-relaxed text-ink-500">
                    일치하는 고객이 없습니다. 전화번호를 입력하면 새
                    고객으로 시작합니다.
                  </div>
                )}
              </div>
            )
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="mt-3 rounded-[9px] border border-open-bg bg-open-bg px-3 py-2.5 text-[12.5px] text-open-fg"
          >
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center gap-2">
          <span className="mr-auto text-[11.5px] text-ink-400">
            본문은 열린 대화에서 입력합니다.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-[9px] border border-line-strong bg-white px-3.5 text-[13px] font-semibold text-ink-600"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={starting || loading || phones.length === 0}
            className="h-9 rounded-[9px] bg-brand px-4 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(16,24,40,.1)] hover:bg-brand-hover disabled:cursor-wait disabled:bg-line-soft"
          >
            {starting ? '여는 중…' : '대화 열기'}
          </button>
        </div>
      </form>
    </>
  )
}
