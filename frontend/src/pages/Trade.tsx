import { useEffect, useState, useRef, useCallback } from 'react'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { PortfolioEntry } from '../types'
import { fmtUSD, fmt, fmtPct, cn } from '../lib/utils'
import { usePrices } from '../hooks/usePrices'

const QUICK_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX']
const PCTS = [25, 50, 75, 100] as const

interface PriceData {
  symbol: string
  price: number
  change24h: number
}

interface TradeResult {
  fromAmount: number
  toAmount: number
  fromPrice: number
  toPrice: number
  fee?: { cost: number; currency: string }
}

export default function Trade() {
  const [coinInput, setCoinInput] = useState('BTC')
  const [symbol, setSymbol] = useState('BTC/USDC')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [amount, setAmount] = useState('')
  const [priceLoading, setPriceLoading] = useState(false)
  const [usdtBalance, setUsdtBalance] = useState(0)
  const [coinBalance, setCoinBalance] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TradeResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Live prices pushed from backend via WebSocket
  const livePrices = usePrices()
  const liveSnap = livePrices.get(symbol)

  // Seed price via REST on first coin selection (cache may be cold)
  const [seedPrice, setSeedPrice] = useState<PriceData | null>(null)
  const price: PriceData | null = liveSnap
    ? { symbol, price: liveSnap.price, change24h: liveSnap.change24h }
    : seedPrice

  const base = symbol.replace('/USDC', '')

  function loadBalances() {
    fetch('/api/portfolio')
      .then(r => r.json())
      .then(data => {
        const entries: PortfolioEntry[] = data.entries ?? []
        const usdt = entries.find(e => e.coin === 'USDC')?.quantity ?? 0
        setUsdtBalance(usdt)
        const coin = entries.find(e => e.coin === symbol)?.quantity ?? 0
        setCoinBalance(coin)
      })
      .catch(() => {})
  }

  const fetchPrice = useCallback((sym: string) => {
    setPriceLoading(true)
    setSeedPrice(null)
    const b = sym.replace('/USDC', '')
    fetch(`/api/price/${b}`)
      .then(r => r.json())
      .then(data => {
        if (!data.error) setSeedPrice({ symbol: sym, price: data.price, change24h: data.change24h })
        else setError(`No price data for ${sym}`)
      })
      .catch(() => setError('Failed to fetch price'))
      .finally(() => setPriceLoading(false))
  }, [])

  useEffect(() => {
    loadBalances()
    fetchPrice(symbol)
  }, [symbol])

  function commitCoin(raw: string) {
    const b = raw.trim().toUpperCase().replace('/USDC', '')
    if (!b) return
    const sym = `${b}/USDC`
    setSymbol(sym)
    setCoinInput(b)
    setAmount('')
    setError(null)
    setResult(null)
  }

  function handleCoinKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commitCoin(coinInput)
  }

  function applyPct(pct: number) {
    const max = side === 'BUY' ? usdtBalance : coinBalance
    const val = (max * pct) / 100
    setAmount(val.toString())
    setError(null)
    setResult(null)
  }

  const parsedAmount = parseFloat(amount) || 0
  const currentPrice = price?.price ?? 0

  // For BUY: amount is USDC spent → coin received
  // For SELL: amount is coin sold → USDC received
  const oppositeAmount = currentPrice > 0 && parsedAmount > 0
    ? side === 'BUY'
      ? parsedAmount / currentPrice
      : parsedAmount * currentPrice
    : 0

  const available = side === 'BUY' ? usdtBalance : coinBalance
  const amountLabel = side === 'BUY' ? 'Amount (USDC)' : `Amount (${base})`
  const amountPlaceholder = `0.00 ${side === 'BUY' ? 'USDC' : base}`
  const receivesLabel = side === 'BUY' ? `≈ ${fmt(oppositeAmount, 6)} ${base}` : `≈ ${fmtUSD(oppositeAmount)}`

  async function executeTrade() {
    if (!parsedAmount || parsedAmount <= 0) { setError('Enter a positive amount'); return }
    setPending(true)
    setError(null)
    setResult(null)
    try {
      const body = side === 'BUY'
        ? { from: 'USDC', to: symbol, amount: parsedAmount }
        : { from: symbol, to: 'USDC', amount: parsedAmount }

      const res = await fetch('/api/trade/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Trade failed'); return }
      setResult(data)
      setAmount('')
      loadBalances()
    } catch {
      setError('Request failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="max-w-md mx-auto space-y-4 animate-fade-in">

      {/* Pair selector */}
      <div className="bg-surface-card border border-border rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              ref={inputRef}
              value={coinInput}
              onChange={e => { setCoinInput(e.target.value.toUpperCase()); setError(null) }}
              onKeyDown={handleCoinKey}
              onBlur={() => commitCoin(coinInput)}
              className={cn(
                'w-full pl-3 pr-16 py-2.5 text-lg font-bold bg-surface-elevated border border-border rounded-xl',
                'text-foreground placeholder:text-muted tracking-wide uppercase',
                'focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 transition-colors',
              )}
              placeholder="BTC"
              spellCheck={false}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted pointer-events-none">
              / USDC
            </span>
          </div>
          <button
            onClick={() => fetchPrice(symbol)}
            className="w-9 h-9 flex items-center justify-center rounded-xl border border-border bg-surface-elevated hover:bg-surface-hover text-muted hover:text-foreground transition-colors"
            title="Refresh price"
          >
            <svg className={cn('w-4 h-4', priceLoading && 'animate-spin')} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </button>
        </div>

        {/* Quick coins */}
        <div className="flex flex-wrap gap-1.5">
          {QUICK_COINS.map(c => (
            <button
              key={c}
              onClick={() => { setCoinInput(c); commitCoin(c) }}
              className={cn(
                'px-2.5 py-1 text-xs font-medium rounded-lg border transition-all duration-150',
                symbol === `${c}/USDC`
                  ? 'bg-accent/10 border-accent/40 text-accent'
                  : 'bg-surface-elevated border-border text-muted hover:text-foreground hover:border-border/80',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Price display */}
      <div className="bg-surface-card border border-border rounded-2xl px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-xs text-muted mb-0.5">{symbol}</p>
          {priceLoading ? (
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted">Loading…</span>
            </div>
          ) : price ? (
            <p className="text-2xl font-bold tabular-nums">{fmtUSD(price.price)}</p>
          ) : (
            <p className="text-sm text-muted">—</p>
          )}
        </div>
        {price && (
          <div className={cn(
            'px-2.5 py-1 rounded-lg text-xs font-semibold',
            price.change24h >= 0 ? 'bg-buy/10 text-buy' : 'bg-sell/10 text-sell',
          )}>
            {fmtPct(price.change24h)} 24h
          </div>
        )}
      </div>

      {/* Order form */}
      <div className="bg-surface-card border border-border rounded-2xl overflow-hidden">

        {/* BUY / SELL tabs */}
        <div className="grid grid-cols-2">
          <button
            onClick={() => { setSide('BUY'); setAmount(''); setError(null); setResult(null) }}
            className={cn(
              'py-3 text-sm font-bold tracking-wide transition-all duration-150',
              side === 'BUY' ? 'bg-buy/10 text-buy border-b-2 border-buy' : 'text-muted hover:text-foreground border-b border-border',
            )}
          >
            BUY
          </button>
          <button
            onClick={() => { setSide('SELL'); setAmount(''); setError(null); setResult(null) }}
            className={cn(
              'py-3 text-sm font-bold tracking-wide transition-all duration-150',
              side === 'SELL' ? 'bg-sell/10 text-sell border-b-2 border-sell' : 'text-muted hover:text-foreground border-b border-border',
            )}
          >
            SELL
          </button>
        </div>

        <div className="p-4 space-y-4">

          {/* Available balance */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">Available</span>
            <span className="font-medium tabular-nums">
              {side === 'BUY'
                ? `${fmtUSD(usdtBalance)} USDC`
                : coinBalance > 0
                  ? `${fmt(coinBalance, 6)} ${base}`
                  : <span className="text-muted">No {base} held</span>
              }
            </span>
          </div>

          {/* % quick-fill */}
          <div className="grid grid-cols-4 gap-1.5">
            {PCTS.map(pct => (
              <button
                key={pct}
                onClick={() => applyPct(pct)}
                className="py-1.5 text-xs font-medium rounded-lg border border-border bg-surface-elevated hover:bg-surface-hover transition-all duration-150"
              >
                {pct}%
              </button>
            ))}
          </div>

          {/* Amount input */}
          <Input
            type="number"
            min="0"
            step="any"
            label={amountLabel}
            value={amount}
            onChange={e => { setAmount(e.target.value); setError(null); setResult(null) }}
            placeholder={amountPlaceholder}
            error={error ?? undefined}
          />

          {/* You receive */}
          <div className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-surface-elevated">
            <span className="text-xs text-muted">You receive</span>
            <span className={cn(
              'text-sm font-semibold tabular-nums',
              oppositeAmount > 0 ? (side === 'BUY' ? 'text-buy' : 'text-sell') : 'text-muted',
            )}>
              {oppositeAmount > 0 ? receivesLabel : '—'}
            </span>
          </div>

          {/* Execute */}
          <Button
            variant={side === 'BUY' ? 'success' : 'danger'}
            size="lg"
            loading={pending}
            disabled={!parsedAmount || parsedAmount <= 0 || !price || pending}
            onClick={executeTrade}
            className="w-full"
          >
            {side === 'BUY' ? `Buy ${base}` : `Sell ${base}`}
          </Button>

          {/* Result */}
          {result && (
            <div className={cn(
              'p-3 rounded-xl border text-xs space-y-1.5',
              side === 'BUY' ? 'border-buy/30 bg-buy/5' : 'border-sell/20 bg-sell/5',
            )}>
              <p className={cn('font-semibold text-sm', side === 'BUY' ? 'text-buy' : 'text-sell')}>
                Order filled
              </p>
              {side === 'BUY' ? (
                <>
                  <Row label="Spent" value={`${fmtUSD(result.fromAmount)} USDC`} />
                  <Row label="Received" value={`${fmt(result.toAmount, 6)} ${base}`} highlight />
                  <Row label="Price" value={fmtUSD(result.toPrice)} />
                </>
              ) : (
                <>
                  <Row label="Sold" value={`${fmt(result.fromAmount, 6)} ${base} @ ${fmtUSD(result.fromPrice)}`} />
                  <Row label="Received" value={`${fmtUSD(result.toAmount)} USDC`} highlight />
                </>
              )}
              {result.fee && <Row label="Fee" value={`${fmtUSD(result.fee.cost)} ${result.fee.currency}`} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span className={cn('font-medium tabular-nums', highlight && 'text-foreground font-semibold')}>{value}</span>
    </div>
  )
}
