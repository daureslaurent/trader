import { useEffect, useState, useRef, useCallback } from 'react'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Card, CardHeader } from '../components/ui/Card'
import { CandleChart } from '../components/CandleChart'
import { TradeHistory } from '../components/TradeHistory'
import type { PortfolioEntry, Trade, Decision } from '../types'
import { fmtUSD, fmt, fmtPct, cn } from '../lib/utils'
import { usePrices } from '../hooks/usePrices'

const QUICK_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX']
const PCTS = [25, 50, 75, 100] as const

type HistoryFilter = 'all' | 'EXECUTED' | 'FAILED' | 'PENDING'

interface PriceData { symbol: string; price: number; change24h: number }
interface TradeResult {
  fromAmount: number; toAmount: number
  fromPrice: number; toPrice: number
  fee?: { cost: number; currency: string }
}

export default function Trade() {
  // Form state
  const [coinInput, setCoinInput] = useState(() => localStorage.getItem('trade_coin') ?? 'BTC')
  const [symbol, setSymbol] = useState(() => {
    const saved = localStorage.getItem('trade_coin')
    return saved ? `${saved}/USDC` : 'BTC/USDC'
  })
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [amount, setAmount] = useState('')
  const [priceLoading, setPriceLoading] = useState(false)
  const [usdcBalance, setUsdcBalance] = useState(0)
  const [coinBalance, setCoinBalance] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TradeResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Extra coins from watchlist / portfolio not in QUICK_COINS
  const [extraCoins, setExtraCoins] = useState<string[]>([])

  // Signal + history state
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [trades, setTrades] = useState<Trade[]>([])
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all')

  // Live prices from WebSocket
  const livePrices = usePrices()
  const liveSnap = livePrices.get(symbol)
  const [seedPrice, setSeedPrice] = useState<PriceData | null>(null)
  const price: PriceData | null = liveSnap
    ? { symbol, price: liveSnap.price, change24h: liveSnap.change24h }
    : seedPrice

  useEffect(() => { localStorage.setItem('trade_coin', symbol.replace('/USDC', '')) }, [symbol])

  const base = symbol.replace('/USDC', '')

  function loadData() {
    Promise.all([
      fetch('/api/portfolio').then(r => r.json()),
      fetch('/api/settings').then(r => r.json()),
    ]).then(([portfolioData, settingsData]) => {
      const entries: PortfolioEntry[] = portfolioData.entries ?? []
      setUsdcBalance(entries.find(e => e.coin === 'USDC')?.quantity ?? 0)
      setCoinBalance(entries.find(e => e.coin === symbol)?.quantity ?? 0)

      const wlCoins: string[] = (settingsData.watchlist ?? []).map((s: string) => s.replace('/USDC', ''))
      const portfolioCoins: string[] = entries
        .filter(e => e.coin !== 'USDC' && e.coin.includes('/'))
        .map(e => e.coin.replace('/USDC', ''))
      const extra = [...new Set([...wlCoins, ...portfolioCoins])].filter(c => !QUICK_COINS.includes(c))
      setExtraCoins(extra)
    }).catch(() => {})
    fetch('/api/trades').then(r => r.json()).then(setTrades).catch(() => {})
    fetch('/api/decisions').then(r => r.json()).then(setDecisions).catch(() => {})
  }

  const fetchPrice = useCallback((sym: string) => {
    setPriceLoading(true)
    setSeedPrice(null)
    fetch(`/api/price/${sym.replace('/USDC', '')}`)
      .then(r => r.json())
      .then(data => {
        if (!data.error) setSeedPrice({ symbol: sym, price: data.price, change24h: data.change24h })
        else setError(`No price data for ${sym}`)
      })
      .catch(() => setError('Failed to fetch price'))
      .finally(() => setPriceLoading(false))
  }, [])

  useEffect(() => {
    loadData()
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
    const max = side === 'BUY' ? usdcBalance : coinBalance
    setAmount(((max * pct) / 100).toString())
    setError(null)
    setResult(null)
  }

  const parsedAmount = parseFloat(amount) || 0
  const currentPrice = price?.price ?? 0
  const oppositeAmount = currentPrice > 0 && parsedAmount > 0
    ? side === 'BUY' ? parsedAmount / currentPrice : parsedAmount * currentPrice
    : 0
  const amountLabel = side === 'BUY' ? 'Amount (USDC)' : `Amount (${base})`
  const amountPlaceholder = `0.00 ${side === 'BUY' ? 'USDC' : base}`
  const receivesLabel = side === 'BUY'
    ? `≈ ${fmt(oppositeAmount, 6)} ${base}`
    : `≈ ${fmtUSD(oppositeAmount)}`

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
      loadData()
    } catch {
      setError('Request failed')
    } finally {
      setPending(false)
    }
  }

  const filteredTrades = historyFilter === 'all' ? trades : trades.filter(t => t.status === historyFilter)
  const countBy = (s: Trade['status']) => trades.filter(t => t.status === s).length
  const failedCount = countBy('FAILED')

  async function clearFailedTrades() {
    await fetch('/api/trades/failed', { method: 'DELETE' })
    if (historyFilter === 'FAILED') setHistoryFilter('all')
    loadData()
  }

  return (
    <div className="h-full flex flex-col gap-6 animate-fade-in">

      {/* Price candlestick chart with analyst signals overlaid */}
      <Card noPad className="shrink-0">
        <div className="px-5 pt-5 pb-2">
          <CardHeader
            title={`${base}/USDC`}
            subtitle="Live candlestick prices from Binance — signals & trades marked on chart"
          />
        </div>
        <CandleChart symbol={symbol} decisions={decisions} trades={trades} />
      </Card>

      {/* Trade form + Trade history */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6">

        {/* Trade form */}
        <div className="space-y-4 overflow-y-auto">

          {/* Pair selector */}
          <div className="bg-surface-card border border-border rounded-2xl neon-border p-4 space-y-3">
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
            <div className="flex flex-wrap gap-1.5">
              {QUICK_COINS.map(c => (
                <button
                  key={c}
                  onClick={() => { setCoinInput(c); commitCoin(c) }}
                  className={cn(
                    'px-2.5 py-1 text-xs font-medium rounded-lg border transition-all duration-150',
                    symbol === `${c}/USDC`
                      ? 'bg-accent/10 border-accent/40 text-accent'
                      : 'bg-surface-elevated border-border text-muted hover:text-foreground',
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
            {extraCoins.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1.5 border-t border-border/40">
                {extraCoins.map(c => (
                  <button
                    key={c}
                    onClick={() => { setCoinInput(c); commitCoin(c) }}
                    className={cn(
                      'px-2.5 py-1 text-xs font-medium rounded-lg border transition-all duration-150',
                      symbol === `${c}/USDC`
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

          {/* Price display */}
          <div className="bg-surface-card border border-border rounded-2xl neon-border px-4 py-3 flex items-center justify-between">
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
          <div className="bg-surface-card border border-border rounded-2xl neon-border overflow-hidden">
            <div className="grid grid-cols-2">
              <button
                onClick={() => { setSide('BUY'); setAmount(''); setError(null); setResult(null) }}
                className={cn(
                  'py-3 text-sm font-bold tracking-wide transition-all duration-150',
                  side === 'BUY'
                    ? 'bg-buy/10 text-buy border-b-2 border-buy'
                    : 'text-muted hover:text-foreground border-b border-border',
                )}
              >
                BUY
              </button>
              <button
                onClick={() => { setSide('SELL'); setAmount(''); setError(null); setResult(null) }}
                className={cn(
                  'py-3 text-sm font-bold tracking-wide transition-all duration-150',
                  side === 'SELL'
                    ? 'bg-sell/10 text-sell border-b-2 border-sell'
                    : 'text-muted hover:text-foreground border-b border-border',
                )}
              >
                SELL
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Available</span>
                <span className="font-medium tabular-nums">
                  {side === 'BUY'
                    ? `${fmtUSD(usdcBalance)} USDC`
                    : coinBalance > 0
                      ? `${fmt(coinBalance, 6)} ${base}`
                      : <span className="text-muted">No {base} held</span>
                  }
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {PCTS.map(pct => (
                  <button
                    key={pct}
                    onClick={() => applyPct(pct)}
                    className="py-1.5 text-xs font-medium rounded-lg border border-border bg-surface-elevated hover:bg-surface-hover transition-all"
                  >
                    {pct}%
                  </button>
                ))}
              </div>
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
              <div className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-surface-elevated">
                <span className="text-xs text-muted">You receive</span>
                <span className={cn(
                  'text-sm font-semibold tabular-nums',
                  oppositeAmount > 0 ? (side === 'BUY' ? 'text-buy' : 'text-sell') : 'text-muted',
                )}>
                  {oppositeAmount > 0 ? receivesLabel : '—'}
                </span>
              </div>
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

        {/* Trade history */}
        <Card noPad className="h-full flex flex-col overflow-hidden">
          <div className="px-5 pt-5 pb-3">
            <CardHeader title="Trade History" subtitle={`${trades.length} total`} />
            <div className="flex items-center justify-between -mt-2">
              <div className="flex gap-1.5">
                {(['all', 'EXECUTED', 'FAILED', 'PENDING'] as const).map(f => {
                  const count = f === 'all' ? trades.length : countBy(f)
                  const active = historyFilter === f
                  return (
                    <button
                      key={f}
                      onClick={() => setHistoryFilter(f)}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                        active ? 'bg-accent/10 text-accent' : 'text-muted hover:text-foreground hover:bg-surface-elevated',
                      )}
                    >
                      {f === 'all' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
                      {count > 0 && (
                        <span className={cn(
                          'px-1.5 py-0.5 rounded text-[10px] font-semibold',
                          f === 'FAILED' ? 'bg-sell/10 text-sell' : 'bg-surface-elevated text-muted',
                          active && f !== 'FAILED' && 'bg-accent/10 text-accent',
                        )}>
                          {count}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              {failedCount > 0 && (
                <button
                  onClick={clearFailedTrades}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-sell/30 text-sell hover:bg-sell/10 transition-all"
                  title="Delete all failed trades"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Clear failed
                </button>
              )}
            </div>
          </div>
          <div className="px-5 pb-5 overflow-y-auto flex-1 min-h-0">
            <TradeHistory trades={filteredTrades} />
          </div>
        </Card>

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
