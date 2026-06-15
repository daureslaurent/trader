import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

interface ManualEntryModalProps {
  open: boolean
  onClose: () => void
  /** Whether the Entry Planner is on — drives the "AI levels" note in the dialog. */
  plannerEnabled?: boolean
  /** Coins already on the watchlist, offered as a datalist for quick entry. */
  suggestions?: string[]
  /** Fired with the staged coin on success so the caller can select it. */
  onStaged?: (coin: string) => void
}

export function ManualEntryModal({ open, onClose, plannerEnabled, suggestions = [], onStaged }: ManualEntryModalProps) {
  const [coin, setCoin] = useState('')
  const [notional, setNotional] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset + focus whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setCoin('')
    setNotional('')
    setError(null)
    setSubmitting(false)
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open])

  // ESC to close (ignored mid-request).
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, submitting, onClose])

  if (!open) return null

  async function submit() {
    const trimmed = coin.trim().toUpperCase()
    if (!trimmed) { setError('Enter a coin symbol'); return }
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/entry-intents/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coin: trimmed, notional: notional.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? 'Could not stage entry'); return }
      onStaged?.(data.coin ?? (trimmed.includes('/') ? trimmed : `${trimmed}/USDC`))
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
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">Add coin to Entry Desk</h2>
            <p className="text-xs text-muted mt-0.5 leading-relaxed">
              Stages a deferred BUY without the research pipeline. {plannerEnabled
                ? 'The Entry Planner LLM picks the entry window'
                : 'The static entry band is used'} and the engine waits for a good fill — just like a pipeline BUY.
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <div className="flex flex-col gap-1.5">
            <Input
              ref={inputRef}
              label="Coin"
              placeholder="e.g. BTC or SOL/USDC"
              value={coin}
              list="manual-entry-coins"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              onChange={(e) => setCoin(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            />
            {suggestions.length > 0 && (
              <datalist id="manual-entry-coins">
                {suggestions.map((c) => <option key={c} value={c.replace('/USDC', '')} />)}
              </datalist>
            )}
            <p className="text-xs text-muted">Quoted in USDC — <span className="font-mono">/USDC</span> is added automatically.</p>
          </div>

          <Input
            label="Notional (USDC) — optional"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            placeholder="Auto-sized"
            value={notional}
            disabled={submitting}
            onChange={(e) => setNotional(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            hint="Leave blank to use the bot's usual position sizing."
          />

          {error && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-sell/10 border border-sell/20 text-xs text-sell">
              <svg className="h-3.5 w-3.5 mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008M10.34 3.94l-7.5 12.99A1.5 1.5 0 004.14 19.5h15.72a1.5 1.5 0 001.3-2.57l-7.5-12.99a1.5 1.5 0 00-2.62 0z" />
              </svg>
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex gap-2">
          <Button variant="secondary" size="md" onClick={onClose} disabled={submitting} className="flex-1">
            Cancel
          </Button>
          <Button variant="primary" size="md" loading={submitting} onClick={submit} className="flex-1">
            {submitting ? 'Staging…' : 'Add to desk'}
          </Button>
        </div>
      </div>
    </div>
  )
}
