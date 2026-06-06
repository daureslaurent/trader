import { useEffect, useState } from 'react'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { cn, fmt } from '../lib/utils'
import { PortfolioEntry } from '../types'

type Direction = 'from_binance' | 'to_binance'

interface TransferModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
  localEntries: PortfolioEntry[]
}

export function TransferModal({ open, onClose, onSuccess, localEntries }: TransferModalProps) {
  const [direction, setDirection] = useState<Direction>('from_binance')
  const [coin, setCoin] = useState('')
  const [quantity, setQuantity] = useState('')
  const [buyPrice, setBuyPrice] = useState('')
  const [binanceBalances, setBinanceBalances] = useState<Record<string, number>>({})
  const [watchlist, setWatchlist] = useState<string[]>([])
  const [loadingBal, setLoadingBal] = useState(false)
  const [loadingPrice, setLoadingPrice] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rawCoin = coin.trim().toUpperCase()
  const symbol = rawCoin ? (rawCoin.includes('/') ? rawCoin : `${rawCoin}/USDC`) : ''
  const asset = symbol.split('/')[0] || ''

  const binanceQty = asset ? (binanceBalances[asset] ?? 0) : 0
  const localQty = symbol
    ? localEntries.filter(e => e.coin === symbol).reduce((s, e) => s + e.quantity, 0)
    : 0
  const maxQty = direction === 'from_binance' ? binanceQty : localQty

  // Fetch watchlist + Binance balances when modal opens
  useEffect(() => {
    if (!open) return
    fetch('/api/settings').then(r => r.json()).then(s => {
      const wl: string[] = Array.isArray(s.watchlist) ? s.watchlist : []
      setWatchlist(wl.map((w: string) => w.replace('/USDC', '')))
    }).catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open || direction !== 'from_binance') return
    setLoadingBal(true)
    fetch('/api/binance/balance')
      .then(r => r.json())
      .then(setBinanceBalances)
      .catch(() => {})
      .finally(() => setLoadingBal(false))
  }, [open, direction])

  // Reset on open
  useEffect(() => {
    if (!open) return
    setCoin('')
    setQuantity('')
    setBuyPrice('')
    setError(null)
    setDirection('from_binance')
  }, [open])

  // ESC to close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  async function fetchCurrentPrice() {
    if (!symbol) return
    setLoadingPrice(true)
    try {
      const r = await fetch(`/api/price/${encodeURIComponent(symbol)}`)
      const d = await r.json()
      if (d.price) setBuyPrice(String(d.price))
    } catch {}
    finally { setLoadingPrice(false) }
  }

  async function submit() {
    setError(null)
    const qty = parseFloat(quantity)
    const bp = parseFloat(buyPrice)

    if (!symbol) { setError('Enter a coin symbol'); return }
    if (!qty || qty <= 0) { setError('Enter a positive quantity'); return }
    if (direction === 'from_binance' && (!bp || bp <= 0)) { setError('Enter a buy price (cost basis)'); return }

    setSubmitting(true)
    try {
      const body: Record<string, unknown> = { direction, coin: symbol, quantity: qty }
      if (direction === 'from_binance') body.buy_price = bp

      const res = await fetch('/api/portfolio/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Transfer failed'); return }
      onSuccess()
      onClose()
    } catch {
      setError('Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-md mx-4 bg-surface-card border border-border rounded-2xl neon-border shadow-2xl animate-fade-in">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-foreground">Transfer Coin</h2>
            <p className="text-xs text-muted mt-0.5">Sync holdings between Binance and local portfolio</p>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-surface-elevated"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">

          {/* Direction */}
          <div>
            <p className="text-xs font-medium text-muted mb-2">Direction</p>
            <div className="grid grid-cols-2 gap-2">
              {(['from_binance', 'to_binance'] as Direction[]).map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => { setDirection(d); setQuantity(''); setError(null) }}
                  className={cn(
                    'flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl border text-xs font-medium transition-all duration-150',
                    direction === d
                      ? 'bg-accent/10 border-accent/40 text-accent'
                      : 'bg-surface-elevated border-border text-muted hover:text-foreground hover:bg-surface-hover',
                  )}
                >
                  <span className="text-base leading-none">{d === 'from_binance' ? '↓' : '↑'}</span>
                  <span>{d === 'from_binance' ? 'Binance → Local' : 'Local → Binance'}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Coin */}
          <div>
            <Input
              label="Coin"
              type="text"
              placeholder="BTC, ETH, SOL…"
              value={coin}
              onChange={e => { setCoin(e.target.value); setQuantity(''); setError(null) }}
            />
            {watchlist.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {watchlist.slice(0, 8).map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => { setCoin(c); setQuantity(''); setError(null) }}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-lg border transition-all duration-150',
                      rawCoin === c
                        ? 'bg-accent/10 border-accent/40 text-accent'
                        : 'bg-surface-elevated border-border text-muted hover:text-foreground',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Balance info */}
          {symbol && (
            <div className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-surface-elevated border border-border text-xs">
              {direction === 'from_binance' ? (
                <>
                  <span className="text-muted">Binance balance</span>
                  <span className="font-mono font-medium text-foreground">
                    {loadingBal ? '…' : `${fmt(binanceQty, 6)} ${asset}`}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-muted">Local balance</span>
                  <span className={cn('font-mono font-medium', localQty > 0 ? 'text-foreground' : 'text-muted')}>
                    {fmt(localQty, 6)} {asset}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Quantity */}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                label="Quantity"
                type="number"
                min="0"
                step="any"
                placeholder="0.00"
                value={quantity}
                onChange={e => { setQuantity(e.target.value); setError(null) }}
              />
            </div>
            <button
              type="button"
              disabled={maxQty <= 0}
              onClick={() => setQuantity(String(maxQty))}
              className={cn(
                'mb-0 px-3 py-2 text-xs rounded-xl border transition-all duration-150 shrink-0',
                maxQty > 0
                  ? 'bg-surface-elevated border-border text-muted hover:text-foreground hover:bg-surface-hover'
                  : 'opacity-30 cursor-not-allowed bg-surface-elevated border-border text-muted',
              )}
            >
              Max
            </button>
          </div>

          {/* Buy price — from_binance only */}
          {direction === 'from_binance' && (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  label="Buy price (cost basis)"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="0.00"
                  value={buyPrice}
                  onChange={e => { setBuyPrice(e.target.value); setError(null) }}
                  hint="Your average purchase price in USDC"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={loadingPrice}
                disabled={!symbol || loadingPrice}
                onClick={fetchCurrentPrice}
                className="mb-5 shrink-0"
              >
                Current
              </Button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="px-3 py-2.5 rounded-xl bg-sell/10 border border-sell/20 text-xs text-sell">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex gap-2">
          <Button variant="secondary" size="md" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button variant="primary" size="md" loading={submitting} onClick={submit} className="flex-1">
            {direction === 'from_binance' ? 'Import to Local' : 'Remove from Local'}
          </Button>
        </div>
      </div>
    </div>
  )
}
