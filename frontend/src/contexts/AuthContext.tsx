import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { fetchAuthStatus, login as apiLogin, logout as apiLogout, onAuthChange, getToken } from '../lib/auth'
import { fetchSetupStatus } from '../lib/setup'

type Phase = 'loading' | 'setup' | 'login' | 'authed'

interface AuthContextValue {
  phase: Phase
  authEnabled: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [authEnabled, setAuthEnabled] = useState(false)

  // Resolve initial state from the server: needs first-run setup? is auth on, and
  // is our token valid? The setup check comes first — an unconfigured backend has
  // no admin to log into yet.
  useEffect(() => {
    let cancelled = false
    fetchSetupStatus()
      .then(setup => {
        if (cancelled) return undefined
        if (!setup.configured) { setPhase('setup'); return undefined }
        return fetchAuthStatus().then(status => {
          if (cancelled) return
          setAuthEnabled(status.authEnabled)
          setPhase(!status.authEnabled || status.authenticated ? 'authed' : 'login')
        })
      })
      .catch(() => {
        // Server unreachable — assume gated so we don't expose the app blindly,
        // but only show the login form if we don't already hold a token.
        if (!cancelled) setPhase(getToken() ? 'authed' : 'login')
      })
    return () => { cancelled = true }
  }, [])

  // The fetch interceptor clears the token on a 401; bounce back to login.
  useEffect(() => onAuthChange(() => {
    if (!getToken()) setPhase(prev => (prev === 'authed' ? 'login' : prev))
  }), [])

  const login = useCallback(async (username: string, password: string) => {
    await apiLogin(username, password)
    setAuthEnabled(true)
    setPhase('authed')
  }, [])

  const logout = useCallback(() => {
    apiLogout()
    setPhase('login')
  }, [])

  return (
    <AuthContext.Provider value={{ phase, authEnabled, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
