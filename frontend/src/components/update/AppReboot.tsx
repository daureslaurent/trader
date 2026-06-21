import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { RestartOverlay } from './AppUpdate'

/**
 * The "Reboot" action: a button that opens a confirmation modal and, on confirm,
 * POSTs the host reboot trigger and shows the RestartOverlay. Restarts the running
 * containers (`docker compose restart`) — no git pull, no rebuild. Surfaced on the
 * System page next to the update actions. Shares the same gating as updates:
 * `enabled` (the update_enabled master switch) and `bridgeReady` (the host bind
 * mount / watcher being wired up).
 */
export function RebootButton({
  enabled,
  bridgeReady,
  label = 'Reboot',
  variant = 'secondary',
  size = 'sm',
}: {
  enabled: boolean
  bridgeReady: boolean
  label?: string
  variant?: 'primary' | 'ghost' | 'secondary' | 'danger'
  size?: 'sm' | 'md'
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'triggering' | 'rebooting'>('idle')
  const [logSince, setLogSince] = useState(0)
  const [error, setError] = useState<string | null>(null)

  async function trigger() {
    setError(null)
    setPhase('triggering')
    try {
      const res = await fetch('/api/host/reboot', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error || `Request failed (${res.status})`)
      }
      const body = (await res.json().catch(() => ({}))) as { logOffset?: number }
      setLogSince(typeof body.logOffset === 'number' ? body.logOffset : 0)
      setConfirmOpen(false)
      setPhase('rebooting')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start reboot')
      setPhase('idle')
    }
  }

  useEffect(() => {
    if (!confirmOpen) return
    const handler = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setConfirmOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [confirmOpen])

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={!enabled || !bridgeReady}
        onClick={() => { setError(null); setConfirmOpen(true) }}
      >
        {label}
      </Button>

      {confirmOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setConfirmOpen(false)} />
          <div className="relative z-10 mx-4 w-full max-w-md rounded-2xl border border-border bg-surface-card p-6 shadow-2xl animate-fade-in">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 9A8 8 0 006.34 5.34L4 8m0 8a8 8 0 0013.66 3.66L20 16" />
                </svg>
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">Reboot the app?</h2>
                <p className="mt-0.5 text-xs text-muted">Restarts all containers.</p>
              </div>
            </div>

            <ul className="mt-4 space-y-2 text-sm text-muted">
              <li className="flex gap-2"><span className="text-accent">•</span> Runs <code className="font-mono text-foreground">docker compose restart</code> on the host</li>
              <li className="flex gap-2"><span className="text-accent">•</span> No code update — keeps the current version (no pull, no rebuild)</li>
              <li className="flex gap-2"><span className="text-accent">•</span> The app is briefly offline; this page reloads when it’s back</li>
            </ul>

            {error && (
              <div className="mt-4 rounded-lg bg-sell/10 px-3 py-2 text-xs text-sell">{error}</div>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="md" onClick={() => setConfirmOpen(false)} disabled={phase === 'triggering'}>
                Cancel
              </Button>
              <Button type="button" variant="primary" size="md" loading={phase === 'triggering'} onClick={trigger}>
                Reboot now
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === 'rebooting' && (
        <RestartOverlay
          title="Rebooting CryptoBot…"
          message="Restarting the containers. This page will reload automatically once it’s back online."
          logSince={logSince}
        />
      )}
    </>
  )
}
