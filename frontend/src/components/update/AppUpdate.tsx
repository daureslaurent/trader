import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { UpdateCommit } from '../../types'
import { stashPendingUpdate } from '../../lib/whatsNew'

/**
 * Live tail of the host update/reboot log, shown inside the restart overlay.
 * Polls `GET /api/host/update/log?since=<offset>` and appends only the new bytes,
 * so it streams the host-side `git pull` + `docker compose build` output as it
 * happens. With the build running while the old backend still serves, most of the
 * log arrives live; the brief container swap at the end just pauses the poll
 * (failed fetches are swallowed) and it resumes once the backend is back.
 */
function UpdateLogConsole({ since }: { since: number }) {
  const [text, setText] = useState('')
  const offsetRef = useRef(since)
  const boxRef = useRef<HTMLPreElement>(null)
  const pinnedToBottom = useRef(true)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`/api/host/update/log?since=${offsetRef.current}`, { cache: 'no-store' })
        if (!res.ok) return
        const chunk = (await res.json()) as { text: string; offset: number; size: number }
        // A shrunk file means the log was rotated/cleared — restart the tail.
        if (chunk.size < offsetRef.current) { offsetRef.current = 0; setText(''); return }
        offsetRef.current = chunk.offset
        if (chunk.text && !cancelled) setText(prev => prev + chunk.text)
      } catch {
        /* backend down mid-swap — keep what we have and retry next tick */
      }
    }
    void poll()
    const id = setInterval(poll, 1500)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Keep the view pinned to the newest output unless the user scrolls up.
  useEffect(() => {
    const el = boxRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [text])

  if (!text) return null
  return (
    <pre
      ref={boxRef}
      onScroll={e => {
        const el = e.currentTarget
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      className="mx-4 h-48 w-full max-w-2xl overflow-auto rounded-lg border border-border bg-black/40 p-3 text-left font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap"
    >
      {text}
    </pre>
  )
}

/**
 * Full-screen takeover shown while the host restarts the stack (update rebuild or
 * a plain reboot). The backend (and frontend container) go down mid-restart, so we
 * can't be told when it's done — instead we poll the API: once we've seen it go
 * *down* and then come back *up*, the stack is live again and we reload to pick it
 * up. Reused by both the update and reboot flows with different copy. When given
 * `logSince` (the byte offset captured at trigger time), it also tails the host
 * update log so the user sees what's happening on the host.
 */
export function RestartOverlay({ title, message, logSince }: { title: string; message: string; logSince?: number }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const start = Date.now()
    let sawDown = false
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/settings', { cache: 'no-store' })
        if (!res.ok) throw new Error('down')
        // Reachable again — but only reload once it has actually gone down first,
        // otherwise we'd reload before the restart even begins.
        if (sawDown) window.location.reload()
      } catch {
        sawDown = true
      }
    }, 2500)
    return () => { clearInterval(tick); clearInterval(poll) }
  }, [])

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-surface-base/95 backdrop-blur-md animate-fade-in">
      <div className="relative flex h-20 w-20 items-center justify-center">
        <span className="absolute inset-0 rounded-full border-2 border-accent/20" />
        <span className="absolute inset-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        <svg className="h-8 w-8 text-accent" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M20 9A8 8 0 006.34 5.34L4 8m0 8a8 8 0 0013.66 3.66L20 16" />
        </svg>
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="mt-1.5 max-w-sm text-sm text-muted">{message}</p>
        <p className="mt-3 font-mono text-xs text-muted/70">elapsed {mm}:{ss}</p>
      </div>
      {logSince !== undefined && <UpdateLogConsole since={logSince} />}
      <Button type="button" variant="ghost" size="sm" onClick={() => window.location.reload()}>
        Reload now
      </Button>
    </div>
  )
}

/** Overlay shown while an update rebuilds the stack. */
export function UpdatingOverlay({ logSince }: { logSince?: number }) {
  return (
    <RestartOverlay
      title="Updating CryptoBot…"
      message="Pulling the latest version and rebuilding the stack. This page will reload automatically once it’s back online."
      logSince={logSince}
    />
  )
}

/**
 * The "Update app" action: a button that opens a confirmation modal and, on
 * confirm, POSTs the host trigger and shows the UpdatingOverlay. Reused by the
 * System page (inside the commits-ahead modal) and anywhere else an update can be
 * launched. Gated by `enabled` (the update_enabled setting) and `bridgeReady`
 * (the host bind mount / watcher being wired up).
 */
export function UpdateButton({
  enabled,
  bridgeReady,
  label = 'Update app',
  variant = 'primary',
  size = 'md',
  commits,
  fromVersion,
  toVersion,
}: {
  enabled: boolean
  bridgeReady: boolean
  label?: string
  variant?: 'primary' | 'ghost' | 'secondary' | 'danger'
  size?: 'sm' | 'md'
  /** Commits about to be applied — stashed so the "What's new" modal can show them post-update. */
  commits?: UpdateCommit[]
  fromVersion?: string
  toVersion?: string
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'triggering' | 'updating'>('idle')
  const [logSince, setLogSince] = useState(0)
  const [error, setError] = useState<string | null>(null)

  async function trigger() {
    setError(null)
    setPhase('triggering')
    try {
      const res = await fetch('/api/host/update', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error || `Request failed (${res.status})`)
      }
      const body = (await res.json().catch(() => ({}))) as { logOffset?: number }
      setLogSince(typeof body.logOffset === 'number' ? body.logOffset : 0)
      // Capture what's being applied so we can celebrate it once the rebuild lands.
      if (commits && commits.length) {
        stashPendingUpdate({ fromVersion: fromVersion ?? '', toVersion: toVersion ?? '', commits })
      }
      setConfirmOpen(false)
      setPhase('updating')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start update')
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
                <h2 className="text-base font-semibold text-foreground">Update the app?</h2>
                <p className="mt-0.5 text-xs text-muted">This restarts everything.</p>
              </div>
            </div>

            <ul className="mt-4 space-y-2 text-sm text-muted">
              <li className="flex gap-2"><span className="text-accent">•</span> Pulls the latest <code className="font-mono text-foreground">main</code> (discards local changes on the server)</li>
              <li className="flex gap-2"><span className="text-accent">•</span> Rebuilds and restarts all containers</li>
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
                Update now
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === 'updating' && <UpdatingOverlay logSince={logSince} />}
    </>
  )
}

/** Inline hint shown when the host update bridge isn't wired up. */
export function BridgeNotReadyHint({ reason }: { reason?: string }) {
  return (
    <div className="flex items-start gap-2 text-[11px] text-warn">
      <svg className="mt-px h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
      <span>
        Host update bridge not detected{reason ? ` (${reason})` : ''}. Install the watcher on the host with{' '}
        <code className="font-mono text-warn/90">sudo tools/updater/install-updater.sh</code>.
      </span>
    </div>
  )
}
