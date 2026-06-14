import { useEffect, useState } from 'react'
import { Button } from './ui/Button'
import { EntryIntent } from '../types'
import { fmtUSD } from '../lib/utils'

interface CancelEntryModalProps {
  intent: EntryIntent | null
  onClose: () => void
  /** Resolves true on a successful cancel so the caller can clear selection, etc. */
  onCancelled?: (coin: string) => void
}

export function CancelEntryModal({ intent, onClose, onCancelled }: CancelEntryModalProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset transient state whenever a new intent is targeted.
  useEffect(() => {
    setError(null)
    setSubmitting(false)
  }, [intent?.coin])

  // ESC to close (ignored mid-request).
  useEffect(() => {
    if (!intent) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [intent, submitting, onClose])

  if (!intent) return null

  const coin = intent.coin.replace('/USDC', '')

  async function confirm() {
    if (!intent) return
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/entry-intents/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coin: intent.coin }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? 'Cancel failed'); return }
      onCancelled?.(intent.coin)
      onClose()
    } catch {
      setError('Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => { if (!submitting) onClose() }}
      />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-md mx-4 bg-surface-card border border-border rounded-2xl shadow-2xl animate-fade-in">

        {/* Header */}
        <div className="flex items-start gap-3 px-6 py-5 border-b border-border">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sell/10 text-sell">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008M10.34 3.94l-7.5 12.99A1.5 1.5 0 004.14 19.5h15.72a1.5 1.5 0 001.3-2.57l-7.5-12.99a1.5 1.5 0 00-2.62 0z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">Cancel entry for {coin}?</h2>
            <p className="text-xs text-muted mt-0.5 leading-relaxed">
              The deferred BUY will be discarded and the engine will stop watching this entry window. No trade is placed.
            </p>
          </div>
        </div>

        {/* Body — levels recap */}
        <div className="px-6 py-5 space-y-2.5">
          <Row label="Signal price" value={fmtUSD(intent.signalPrice)} />
          <Row label="Buy ≤ (target)" value={fmtUSD(intent.targetPrice)} accent />
          <Row label="Capital queued" value={fmtUSD(intent.notionalUsdc)} />

          {error && (
            <div className="mt-1 px-3 py-2.5 rounded-xl bg-sell/10 border border-sell/20 text-xs text-sell">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex gap-2">
          <Button variant="secondary" size="md" onClick={onClose} disabled={submitting} className="flex-1">
            Keep waiting
          </Button>
          <Button variant="danger" size="md" loading={submitting} onClick={confirm} className="flex-1">
            Cancel entry
          </Button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-surface-elevated border border-border text-xs">
      <span className="text-muted">{label}</span>
      <span className={`font-mono font-medium tabular-nums ${accent ? 'text-accent' : 'text-foreground'}`}>{value}</span>
    </div>
  )
}
