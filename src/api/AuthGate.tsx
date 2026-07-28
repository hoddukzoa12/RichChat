import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { LoginScreen } from '../components/LoginScreen'
import { ApiRequestError, onUnauthorized } from './client'
import { getMe, type MeResponse } from './endpoints'

interface AuthContextValue {
  me: MeResponse
  applyMeResponse: (me: MeResponse) => void
}

type AuthState =
  | { status: 'loading' }
  | { status: 'authenticated'; me: MeResponse }
  | { status: 'unauthenticated' }
  | { status: 'failed'; error: ApiRequestError }

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthGate({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0)
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const applyMeResponse = useCallback((me: MeResponse) => {
    setAuth({ status: 'authenticated', me })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const stopListening = onUnauthorized(() => {
      setAuth({ status: 'unauthenticated' })
    })

    setAuth({ status: 'loading' })
    getMe(controller.signal)
      .then((me) => setAuth({ status: 'authenticated', me }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const failure =
          error instanceof ApiRequestError
            ? error
            : new ApiRequestError(
                'server',
                '로그인 정보를 확인하는 중 알 수 없는 오류가 발생했습니다.',
                { cause: error },
              )
        if (failure.status === 401) {
          setAuth({ status: 'unauthenticated' })
        } else {
          setAuth({ status: 'failed', error: failure })
        }
      })

    return () => {
      controller.abort()
      stopListening()
    }
  }, [attempt])

  if (auth.status === 'loading') {
    return (
      <main className="w-full h-screen min-w-[360px] flex items-center justify-center bg-page text-sm text-ink-500">
        로그인 정보를 확인하고 있습니다.
      </main>
    )
  }

  if (auth.status === 'unauthenticated') return <LoginScreen />

  if (auth.status === 'failed') {
    return (
      <LoginScreen
        error={auth.error}
        onRetry={() => setAttempt((current) => current + 1)}
      />
    )
  }

  return (
    <AuthContext.Provider value={{ me: auth.me, applyMeResponse }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthGate>')
  return value
}
