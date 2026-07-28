import { useState } from 'react'
import { developmentLogin } from '../api/auth'
import { ApiRequestError } from '../api/client'

function failureCopy(error: ApiRequestError): {
  title: string
  description: string
} {
  if (error.kind === 'network') {
    return {
      title: '서버에 연결할 수 없습니다.',
      description: '네트워크 연결을 확인한 뒤 다시 시도해 주세요.',
    }
  }

  return {
    title: '서버 오류가 발생했습니다.',
    description: error.message,
  }
}

export function LoginScreen({
  error,
  onRetry,
}: {
  error?: ApiRequestError
  onRetry?: () => void
}) {
  const [developmentError, setDevelopmentError] =
    useState<ApiRequestError | null>(null)
  const [developmentPending, setDevelopmentPending] = useState(false)
  const failure = developmentError ?? error
  const copy = failure ? failureCopy(failure) : null

  async function logInForDevelopment(): Promise<void> {
    setDevelopmentPending(true)
    setDevelopmentError(null)
    try {
      await developmentLogin()
      window.location.reload()
    } catch (nextError) {
      setDevelopmentPending(false)
      setDevelopmentError(
        nextError instanceof ApiRequestError
          ? nextError
          : new ApiRequestError(
              'server',
              '개발 로그인 중 알 수 없는 오류가 발생했습니다.',
              { cause: nextError },
            ),
      )
    }
  }

  return (
    <main className="w-full h-screen min-w-[360px] min-h-[560px] flex items-center justify-center bg-page px-5 text-sm text-ink">
      <section className="w-full max-w-[400px] rounded-2xl border border-line bg-white px-7 py-8 shadow-[0_16px_48px_rgba(16,24,40,.12)]">
        <img
          src="/logo.png"
          alt="세무법인 리치"
          className="mx-auto h-14 w-14 rounded-xl object-contain"
        />
        <h1 className="mt-5 text-center text-xl font-bold tracking-[-0.4px]">
          상담 인박스
        </h1>
        <p className="mt-2 text-center text-[13px] leading-5 text-ink-500">
          세무법인 리치 계정으로 로그인해 주세요.
        </p>

        {copy && (
          <div
            role="alert"
            className="mt-5 rounded-lg border border-danger-border bg-open-bg px-3.5 py-3"
          >
            <div className="text-[13px] font-semibold text-open-fg">
              {copy.title}
            </div>
            <div className="mt-1 text-[12.5px] leading-5 text-ink-600">
              {copy.description}
            </div>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 text-[12.5px] font-semibold text-brand"
              >
                다시 시도
              </button>
            )}
          </div>
        )}

        <a
          href="/api/auth/login"
          className="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-brand font-semibold text-white hover:bg-brand-hover"
        >
          네이버웍스로 로그인
        </a>

        {import.meta.env.DEV && (
          <button
            type="button"
            disabled={developmentPending}
            onClick={logInForDevelopment}
            className="mt-2.5 flex h-10 w-full items-center justify-center rounded-lg border border-line-strong bg-white text-[13px] font-semibold text-ink-600 disabled:cursor-wait disabled:opacity-60"
          >
            {developmentPending ? '로그인 중…' : '개발 계정으로 로그인'}
          </button>
        )}
      </section>
    </main>
  )
}
