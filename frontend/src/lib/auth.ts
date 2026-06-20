// Frontend auth client. Holds the bearer token (localStorage), talks to the
// auth endpoints, and installs a global fetch interceptor so every existing
// `fetch('/api/...')` call automatically carries the Authorization header and
// reacts to a 401 by dropping the session — no per-call-site changes needed.

const TOKEN_KEY = 'cryptobot.auth.token'

type Listener = () => void
const listeners = new Set<Listener>()
function notify(): void { listeners.forEach(fn => fn()) }

/** Subscribe to token changes (login/logout/expiry). Returns an unsubscribe fn. */
export function onAuthChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}
function setToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token) } catch { /* private mode */ }
  notify()
}
export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
  notify()
}

export interface AuthStatus { authEnabled: boolean; authenticated: boolean }

/** Ask the server whether auth is on and whether our current token is valid. */
export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status')
  if (!res.ok) throw new Error('status check failed')
  return res.json() as Promise<AuthStatus>
}

/** Exchange credentials for a token. Throws with the server's message on failure. */
export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || 'Login failed')
  }
  const data = await res.json() as { token?: string }
  if (data.token) setToken(data.token)
}

export function logout(): void {
  clearToken()
}

function isSameOrigin(url: string): boolean {
  return url.startsWith('/') || url.startsWith(window.location.origin)
}

/**
 * Patch window.fetch once. For same-origin requests it injects the bearer token
 * (unless one is already set) and, on a 401 from a non-auth endpoint, clears the
 * session so the app falls back to the login screen.
 */
export function installFetchInterceptor(): void {
  const original = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const sameOrigin = isSameOrigin(url)
    const token = getToken()

    let nextInit = init
    if (sameOrigin && token) {
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
      nextInit = { ...init, headers }
    }

    const res = await original(input, nextInit)
    if (res.status === 401 && sameOrigin && !url.includes('/api/auth/')) {
      clearToken() // expired/invalid — listeners route back to login
    }
    return res
  }
}
