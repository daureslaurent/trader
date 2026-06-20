// First-run setup client. Mirrors lib/auth.ts but for the (public) setup wizard
// endpoints and the (authed) credential-rotation endpoints.

export interface SetupStatus {
  configured: boolean
  needsBinance: boolean
  needsAdmin: boolean
}

/** Whether the backend still needs first-run configuration. Safe unauthenticated. */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch('/api/setup/status')
  if (!res.ok) throw new Error('setup status check failed')
  return res.json() as Promise<SetupStatus>
}

export interface SetupPayload {
  binanceApiKey: string
  binanceSecret: string
  username: string
  password: string
}

/** Run the first-run wizard. Throws with the server's message on failure. */
export async function submitSetup(p: SetupPayload): Promise<void> {
  const res = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || 'Setup failed')
  }
}

/** Rotate the Binance API keys (validated server-side before saving). Authed. */
export async function rotateBinanceKeys(binanceApiKey: string, binanceSecret: string): Promise<void> {
  const res = await fetch('/api/account/binance-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ binanceApiKey, binanceSecret }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || 'Failed to update keys')
  }
}

/** Change the admin password. Authed. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch('/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || 'Failed to change password')
  }
}
