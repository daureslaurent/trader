import { useCallback, useEffect, useState } from 'react'
import { Card, CardHeader } from '../ui/Card'
import { Button } from '../ui/Button'
import { UpdateInfo } from '../../types'
import { UpdateButton, BridgeNotReadyHint } from './AppUpdate'
import { cn } from '../../lib/utils'

function relTime(iso: string): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return 'never'
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function commitDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * "Software" card for the System page: shows the deployed version, whether
 * origin/main is ahead, a "Check now" action, and — when updates exist — a modal
 * listing the commits ahead with the "Update app" action inside it.
 */
export function SoftwareCard() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/host/update')
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      setInfo(await res.json())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load update status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function checkNow() {
    setChecking(true)
    setError(null)
    try {
      const res = await fetch('/api/host/update/check', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`)
      setInfo(body as UpdateInfo)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check failed')
    } finally {
      setChecking(false)
    }
  }

  const status = info?.status ?? null
  const enabled = info?.enabled ?? false
  const ready = info?.ready ?? false
  const count = status?.behindBy ?? 0
  const hasUpdate = !!info?.updateAvailable

  return (
    <Card>
      <CardHeader
        title="Software"
        subtitle={status?.currentShortSha ? `Deployed · ${status.currentShortSha}` : 'App version & updates'}
        action={
          <div className="flex items-center gap-2">
            {enabled && ready && (
              <Button type="button" variant="secondary" size="sm" loading={checking} onClick={checkNow}>
                Check now
              </Button>
            )}
            {hasUpdate && (
              <Button type="button" variant="primary" size="sm" onClick={() => setModalOpen(true)}>
                View {count} update{count === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        }
      />

      {/* Status line */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {loading ? (
          <span className="text-sm text-muted animate-pulse">Loading…</span>
        ) : !enabled ? (
          <span className="text-sm text-muted">
            App updates are disabled. Turn them on in <span className="text-foreground font-medium">Settings → System</span>.
          </span>
        ) : hasUpdate ? (
          <span className="inline-flex items-center gap-2 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            {count} update{count === 1 ? '' : 's'} available
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-full bg-buy/10 px-3 py-1 text-xs font-semibold text-buy">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            Up to date
          </span>
        )}

        {status?.checkedAt && (
          <span className="text-[11px] text-muted">Last checked {relTime(status.checkedAt)}</span>
        )}
        {status?.remoteShortSha && hasUpdate && (
          <span className="text-[11px] font-mono text-muted">
            {status.currentShortSha} → {status.remoteShortSha}
          </span>
        )}
      </div>

      {error && <div className="mt-3 rounded-lg bg-sell/10 px-3 py-2 text-xs text-sell">{error}</div>}
      {status?.error && (
        <div className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">Host check error: {status.error}</div>
      )}

      {enabled && !ready && !loading && (
        <div className="mt-3">
          <BridgeNotReadyHint reason={info?.reason} />
        </div>
      )}

      {/* Commits-ahead modal */}
      {modalOpen && status && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setModalOpen(false)} />
          <div className="relative z-10 mx-4 flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface-card shadow-2xl animate-fade-in">
            <div className="flex items-start justify-between gap-3 border-b border-border p-5">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {count} new commit{count === 1 ? '' : 's'} on <code className="font-mono text-accent">main</code>
                </h2>
                <p className="mt-0.5 text-xs text-muted font-mono">
                  {status.currentShortSha} → {status.remoteShortSha}
                </p>
              </div>
              <button onClick={() => setModalOpen(false)} className="text-muted hover:text-foreground transition-colors">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              <ol className="relative space-y-4 border-l border-border pl-5">
                {status.commits.map(c => (
                  <li key={c.sha} className="relative">
                    <span className="absolute -left-[23px] top-1.5 h-2 w-2 rounded-full bg-accent" />
                    <p className="text-sm text-foreground leading-snug">{c.subject || '(no message)'}</p>
                    <p className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                      <code className="font-mono">{c.shortSha}</code>
                      <span>·</span>
                      <span>{c.author}</span>
                      {commitDate(c.date) && (<><span>·</span><span>{commitDate(c.date)}</span></>)}
                    </p>
                  </li>
                ))}
                {status.commits.length === 0 && (
                  <li className="text-sm text-muted">No commit details available.</li>
                )}
              </ol>
            </div>

            <div className={cn('flex items-center justify-between gap-3 border-t border-border p-5')}>
              {enabled && !ready ? (
                <BridgeNotReadyHint reason={info?.reason} />
              ) : (
                <p className="text-[11px] text-muted">Updating pulls <code className="font-mono">main</code> and rebuilds the stack.</p>
              )}
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" variant="ghost" size="md" onClick={() => setModalOpen(false)}>Close</Button>
                <UpdateButton enabled={enabled} bridgeReady={ready} label="Update now" />
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
