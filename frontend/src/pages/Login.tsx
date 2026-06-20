import { useState, FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'

export default function Login() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
      setBusy(false)
    }
  }

  return (
    <div className="relative flex items-center justify-center h-full bg-surface-base overflow-hidden">
      <div className="absolute -top-28 -right-20 w-80 h-80 rounded-full bg-accent/10 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-28 -left-20 w-80 h-80 rounded-full bg-accent/10 blur-3xl pointer-events-none" />

      <form
        onSubmit={onSubmit}
        className="relative z-10 w-full max-w-sm bg-surface-card border border-border rounded-2xl shadow-lg p-8 flex flex-col gap-5"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-foreground tracking-tight">cryptoBot</h1>
          <p className="text-xs text-muted">Sign in to access the trader.</p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Username</span>
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoFocus
            className="w-full bg-surface-elevated border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full bg-surface-elevated border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>

        {error && (
          <p className="text-xs text-sell bg-sell/10 border border-sell/20 rounded-lg px-3 py-2">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full bg-accent text-white text-sm font-semibold rounded-lg px-3 py-2.5 hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
