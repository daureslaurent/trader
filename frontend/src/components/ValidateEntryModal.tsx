import { useEffect, useState } from 'react'
import { Button } from './ui/Button'
import { EntryIntent } from '../types'
import { fmtUSD } from '../lib/utils'

interface ValidateEntryModalProps {
  intent: EntryIntent | null
  /** Live price, used to estimate the fill and the quantity bought. */
  currentPrice?: number
  /** Whether the bot requires human approval — surfaced so the buy isn't a surprise. */
  approvalRequired?: boolean
  onClose: () => void
  /** Fired with the coin on a successful validate so the caller can clear selection. */
  onValidated?: (coin: string) => void
}

/**
 * "Validate & open position": stop waiting for a pullback and buy the coin now at
 * the live price. A confirmation step because it commits real capital — the backend
 * still re-checks gates and honors the approval setting before anything executes.
 */
export function ValidateEntryModal({ intent, currentPrice, approvalRequired, onClose, onValidated }: ValidateEntryModalProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    setSubmitting(false)
  }, [intent?.coin])

  useEffect(() => {
    if (!intent) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [intent, submitting, onClose])

  if (!intent) return null

  const coin = intent.coin.replace('/USDC', '')
  const qty = currentPrice && currentPrice > 0 ? intent.notionalUsdc / currentPrice : null
  const vsSignal = currentPrice && intent.signalPrice > 0
    ? ((intent.signalPrice - currentPrice) / intent.signalPrice) * 100
    : null

  async function confirm() {
    if (!intent) return
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/entry-intents/fire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coin: intent.coin }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? 'Could not open the position'); return }
      onValidated?.(intent.coin)
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
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-buy/10 text-buy">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">Open {coin} position now?</h2>
            <p className="text-xs text-muted mt-0.5 leading-relaxed">
              Stops waiting for a pullback and buys {coin} immediately at the live price. The bot re-checks
              its safety limits before executing.
            </p>
          </div>
        </div>

        {/* Body — order recap */}
        <div className="px-6 py-5 space-y-2.5">
          <Row label="Live price" value={currentPrice != null ? fmtUSD(currentPrice) : '—'} />
          <Row
            label="vs signal"
            value={vsSignal != null ? `${vsSignal >= 0 ? '+' : ''}${vsSignal.toFixed(2)}%` : '—'}
            tone={vsSignal != null ? (vsSignal >= 0 ? 'buy' : 'sell') : undefined}
          />
          <Row label="Capital to deploy" value={fmtUSD(intent.notionalUsdc)} accent />
          <Row label="Est. quantity" value={qty != null ? `${qty.toLocaleString(undefined, { maximumSignificantDigits: 6 })} ${coin}` : '—'} />

          {approvalRequired && (
            <div className="mt-1 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-warn/10 border border-warn/20 text-xs text-warn">
              <svg className="h-3.5 w-3.5 mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008M10.34 3.94l-7.5 12.99A1.5 1.5 0 004.14 19.5h15.72a1.5 1.5 0 001.3-2.57l-7.5-12.99a1.5 1.5 0 00-2.62 0z" />
              </svg>
              <span className="leading-relaxed">Approval is required — this will queue a trade for you to confirm, not fill instantly.</span>
            </div>
          )}

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
          <Button variant="success" size="md" loading={submitting} onClick={confirm} className="flex-1">
            {submitting ? 'Opening…' : 'Validate & buy now'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, accent, tone }: { label: string; value: string; accent?: boolean; tone?: 'buy' | 'sell' }) {
  const valueCls = tone === 'buy' ? 'text-buy' : tone === 'sell' ? 'text-sell' : accent ? 'text-accent' : 'text-foreground'
  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-surface-elevated border border-border text-xs">
      <span className="text-muted">{label}</span>
      <span className={`font-mono font-medium tabular-nums ${valueCls}`}>{value}</span>
    </div>
  )
}
