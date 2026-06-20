import { useState, FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { submitSetup } from '../lib/setup'

const MIN_PASSWORD_LEN = 8

const inputClass =
  'w-full bg-surface-elevated border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30'

// First-run wizard: collects the Binance API keys + the admin login, then logs
// straight in. Shown (via AuthGate) only while the backend reports unconfigured.
export default function Setup() {
  const { login } = useAuth()
  const [apiKey, setApiKey] = useState('')
  const [secret, setSecret] = useState('')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const passwordMismatch = confirm.length > 0 && password !== confirm
  const canSubmit =
    !!apiKey && !!secret && !!username && password.length >= MIN_PASSWORD_LEN && password === confirm

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!canSubmit) return
    setBusy(true)
    try {
      await submitSetup({ binanceApiKey: apiKey.trim(), binanceSecret: secret.trim(), username: username.trim(), password })
      // Admin now exists and auth is enabled — log straight in.
      await login(username.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed')
      setBusy(false)
    }
  }

  return (
    <div className="relative flex items-center justify-center h-full bg-surface-base overflow-y-auto py-10">
      <div className="absolute -top-28 -right-20 w-80 h-80 rounded-full bg-accent/10 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-28 -left-20 w-80 h-80 rounded-full bg-accent/10 blur-3xl pointer-events-none" />

      <form
        onSubmit={onSubmit}
        className="relative z-10 w-full max-w-md bg-surface-card border border-border rounded-2xl shadow-lg p-8 flex flex-col gap-5"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-foreground tracking-tight">Welcome to cryptoBot</h1>
          <p className="text-xs text-muted">
            First-run setup. Connect your Binance account and create an admin login. Your secret is
            validated against Binance and stored encrypted.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Binance API</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">API key</span>
            <input type="text" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} autoFocus className={inputClass} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">API secret</span>
            <input type="password" autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)} className={inputClass} />
          </label>
        </div>

        <div className="flex flex-col gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Admin login</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Username</span>
            <input type="text" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Password</span>
            <input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
            {password.length > 0 && password.length < MIN_PASSWORD_LEN && (
              <span className="text-[11px] text-muted">At least {MIN_PASSWORD_LEN} characters.</span>
            )}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Confirm password</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} className={inputClass} />
            {passwordMismatch && <span className="text-[11px] text-sell">Passwords don’t match.</span>}
          </label>
        </div>

        {error && (
          <p className="text-xs text-sell bg-sell/10 border border-sell/20 rounded-lg px-3 py-2 break-words">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy || !canSubmit}
          className="w-full bg-accent text-white text-sm font-semibold rounded-lg px-3 py-2.5 hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Validating & saving…' : 'Complete setup'}
        </button>
      </form>
    </div>
  )
}
