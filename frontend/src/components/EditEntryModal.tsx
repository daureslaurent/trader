import { useEffect, useState } from 'react'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { EntryIntent } from '../types'
import { fmtUSD } from '../lib/utils'

interface EditEntryModalProps {
  intent: EntryIntent | null
  /** Live price, shown for reference against the levels being typed. */
  currentPrice?: number
  onClose: () => void
  /** Fired with the coin on a successful save. */
  onSaved?: (coin: string) => void
}

/** Minutes-from-now remaining on an intent's TTL, for prefilling the form. */
function remainingMinutes(expiresAt: number): string {
  const m = Math.round((expiresAt - Date.now()) / 60_000)
  return m > 0 ? String(m) : ''
}

/**
 * Manually override an active intent's entry window. Prices are absolute USD; the
 * band must stay ordered (invalidate < buy target < chase cap). Saving flags the
 * band as user-set and re-anchors the TTL from now. The backend re-validates.
 */
export function EditEntryModal({ intent, currentPrice, onClose, onSaved }: EditEntryModalProps) {
  const [target, setTarget] = useState('')
  const [invalidate, setInvalidate] = useState('')
  const [chaseCap, setChaseCap] = useState('')
  const [ttl, setTtl] = useState('')
  const [notional, setNotional] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prefill from the targeted intent whenever it changes.
  useEffect(() => {
    if (!intent) return
    setTarget(String(intent.targetPrice))
    setInvalidate(String(intent.invalidatePrice))
    setChaseCap(String(intent.chaseCapPrice))
    setTtl(remainingMinutes(intent.expiresAt))
    setNotional(String(intent.notionalUsdc))
    setError(null)
    setSubmitting(false)
  }, [intent?.coin]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!intent) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [intent, submitting, onClose])

  if (!intent) return null

  const coin = intent.coin.replace('/USDC', '')

  // Live client-side band check so the Save button can guide before the round-trip.
  const t = Number(target), inv = Number(invalidate), cap = Number(chaseCap)
  const numsOk = [t, inv, cap].every(n => Number.isFinite(n) && n > 0)
  const orderOk = numsOk && inv < t && cap > t
  const bandError = !numsOk
    ? null // empty/typing — don't nag yet
    : !(inv < t) ? 'Invalidate must be below the buy target'
    : !(cap > t) ? 'Chase cap must be above the buy target'
    : null

  async function save() {
    if (!intent || !orderOk) return
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/entry-intents/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coin: intent.coin,
          targetPrice: target,
          invalidatePrice: invalidate,
          chaseCapPrice: chaseCap,
          ttlMinutes: ttl.trim() || undefined,
          notionalUsdc: notional.trim() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? 'Could not save changes'); return }
      onSaved?.(intent.coin)
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
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">Edit {coin} entry window</h2>
            <p className="text-xs text-muted mt-0.5 leading-relaxed">
              Override the levels the engine watches. Live price {currentPrice != null ? (
                <span className="font-mono text-foreground">{fmtUSD(currentPrice)}</span>
              ) : '—'} · signal <span className="font-mono text-foreground">{fmtUSD(intent.signalPrice)}</span>.
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <Input
            label="Buy ≤ target (USD)"
            type="number" inputMode="decimal" min="0" step="any"
            value={target} disabled={submitting}
            onChange={(e) => setTarget(e.target.value)}
            hint="Engine fills when the live price dips to or below this."
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Invalidate (USD)"
              type="number" inputMode="decimal" min="0" step="any"
              value={invalidate} disabled={submitting}
              onChange={(e) => setInvalidate(e.target.value)}
            />
            <Input
              label="Chase cap (USD)"
              type="number" inputMode="decimal" min="0" step="any"
              value={chaseCap} disabled={submitting}
              onChange={(e) => setChaseCap(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="TTL (minutes from now)"
              type="number" inputMode="numeric" min="1" step="1"
              value={ttl} disabled={submitting}
              onChange={(e) => setTtl(e.target.value)}
              hint="Resets the expiry clock."
            />
            <Input
              label="Notional (USDC)"
              type="number" inputMode="decimal" min="0" step="any"
              value={notional} disabled={submitting}
              onChange={(e) => setNotional(e.target.value)}
            />
          </div>

          {(bandError || error) && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-sell/10 border border-sell/20 text-xs text-sell">
              <svg className="h-3.5 w-3.5 mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008M10.34 3.94l-7.5 12.99A1.5 1.5 0 004.14 19.5h15.72a1.5 1.5 0 001.3-2.57l-7.5-12.99a1.5 1.5 0 00-2.62 0z" />
              </svg>
              <span className="leading-relaxed">{error ?? bandError}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex gap-2">
          <Button variant="secondary" size="md" onClick={onClose} disabled={submitting} className="flex-1">
            Cancel
          </Button>
          <Button variant="primary" size="md" loading={submitting} disabled={!orderOk} onClick={save} className="flex-1">
            {submitting ? 'Saving…' : 'Save levels'}
          </Button>
        </div>
      </div>
    </div>
  )
}
