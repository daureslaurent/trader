import { useEffect, useState } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Stat } from '../components/ui/Stat'
import { Input } from '../components/ui/Input'
import { TransferModal } from '../components/TransferModal'
import { PortfolioEntry, PortfolioResponse, GainsResponse, ActivePosition } from '../types'
import { fmtUSD, fmtPct, fmt } from '../lib/utils'
import { cn } from '../lib/utils'
import { usePrices } from '../hooks/usePrices'

// ── Icons ──────────────────────────────────────────────────────────────────

const WalletIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
  </svg>
)

// ── Source badge ───────────────────────────────────────────────────────────

const SOURCE: Record<string, { label: string; cls: string }> = {
  trade:    { label: 'Bot',      cls: 'bg-accent/10 text-accent border-accent/20' },
  transfer: { label: 'Transfer', cls: 'bg-surface-hover text-foreground border-border' },
  manual:   { label: 'Manual',   cls: 'bg-surface-hover text-muted border-border' },
}

function SourceBadge({ source }: { source?: string }) {
  const s = SOURCE[source ?? ''] ?? SOURCE.manual
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 text-xs rounded-md border font-medium', s.cls)}>
      {s.label}
    </span>
  )
}

// ── Th / Td helpers ────────────────────────────────────────────────────────

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={cn('py-2.5 px-4 text-xs font-medium text-muted uppercase tracking-wide', right ? 'text-right' : 'text-left')}>
      {children}
    </th>
  )
}

function Td({ children, right, className }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <td className={cn('py-3 px-4', right && 'text-right tabular-nums', className)}>
      {children}
    </td>
  )
}

// ── Component ──────────────────────────────────────────────────────────────

export default function Portfolio() {
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null)
  const [gains, setGains] = useState<GainsResponse | null>(null)
  const [positions, setPositions] = useState<ActivePosition[]>([])
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState('')
  const [txError, setTxError] = useState<string | null>(null)
  const [txPending, setTxPending] = useState<'deposit' | 'withdraw' | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const livePrices = usePrices()

  function load() {
    setLoading(true)
    Promise.all([
      fetch('/api/portfolio').then(r => r.json()),
      fetch('/api/portfolio/gains').then(r => r.json()),
      fetch('/api/positions').then(r => r.json()),
    ]).then(([p, g, pos]) => {
      setPortfolio(p)
      setGains(g)
      setPositions(Array.isArray(pos) ? pos : [])
    }).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const usdcEntry = portfolio?.entries.find(e => e.coin === 'USDC')
  const usdcBalance = usdcEntry?.quantity ?? 0
  const openCount = portfolio?.open_position_count ?? 0
  const maxPositions = portfolio?.max_open_positions ?? 5

  const holdings: PortfolioEntry[] = (portfolio?.entries.filter(e => e.coin !== 'USDC') ?? []).map(h => {
    const live = livePrices.get(h.coin)
    if (!live) return h
    const currentPrice = live.price
    const deltaUsd = h.buy_price > 0 ? Math.round((currentPrice - h.buy_price) * h.quantity * 100) / 100 : null
    const deltaPct = h.buy_price > 0 ? Math.round(((currentPrice - h.buy_price) / h.buy_price) * 10000) / 100 : null
    return { ...h, current_price: currentPrice, delta_usd: deltaUsd, delta_pct: deltaPct }
  })

  const livePositions: ActivePosition[] = positions.map(pos => {
    const live = livePrices.get(pos.coin as string)
    if (!live) return pos
    const currentPrice = live.price
    const entryPrice = pos.entry_price as number
    const qty = pos.quantity as number
    const pnl = Math.round((qty * (currentPrice - entryPrice)) * 100) / 100
    const pnlPct = Math.round(((currentPrice - entryPrice) / entryPrice) * 10000) / 100
    const distanceToSlPct = pos.stop_loss ? Math.round(((currentPrice - (pos.stop_loss as number)) / currentPrice) * 10000) / 100 : null
    const distanceToTpPct = pos.take_profit ? Math.round((((pos.take_profit as number) - currentPrice) / currentPrice) * 10000) / 100 : null
    return { ...pos, current_price: currentPrice, pnl, pnl_pct: pnlPct, distance_to_sl_pct: distanceToSlPct, distance_to_tp_pct: distanceToTpPct }
  })

  const totalValue = usdcBalance + holdings.reduce((sum, h) => sum + (h.current_price != null ? h.current_price * h.quantity : 0), 0)

  async function handleTransaction(type: 'deposit' | 'withdraw') {
    const parsed = parseFloat(amount)
    if (!parsed || parsed <= 0) { setTxError('Enter a positive amount'); return }
    setTxPending(type)
    setTxError(null)
    try {
      const res = await fetch(`/api/portfolio/usdc/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: parsed }),
      })
      const data = await res.json()
      if (!res.ok) { setTxError(data.error ?? 'Failed'); return }
      setAmount('')
      load()
    } catch {
      setTxError('Request failed')
    } finally {
      setTxPending(null)
    }
  }

  if (loading && !portfolio) {
    return <div className="flex items-center justify-center h-40"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>
  }

  return (
    <div className="space-y-6 animate-fade-in">

      {/* ── Stats ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Stat label="Total Value" value={fmtUSD(livePrices.size > 0 ? totalValue : (portfolio?.total_value ?? 0))} icon={<WalletIcon />} />
        <Stat
          label="Bot Positions"
          value={`${openCount} / ${maxPositions}`}
          sub={openCount >= maxPositions ? 'limit reached' : `${maxPositions - openCount} slot${maxPositions - openCount !== 1 ? 's' : ''} free`}
          trend={openCount >= maxPositions ? 'down' : 'neutral'}
        />
        <Stat label="USDC Balance" value={fmtUSD(usdcBalance)} trend="neutral" />
      </div>

      {/* ── Active Positions ──────────────────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader
            title="Active Positions"
            subtitle="Bot-managed trades with stop-loss and take-profit monitoring"
          />
        </div>

        {positions.length === 0 ? (
          <div className="px-5 pb-6 text-center text-sm text-muted">
            No active bot positions — the trading engine hasn't opened any monitored trades yet.
          </div>
        ) : (
          <div className="overflow-x-auto pb-1">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="border-b border-border">
                  <Th>Coin</Th>
                  <Th right>Qty</Th>
                  <Th right>Entry</Th>
                  <Th right>Current</Th>
                  <Th right>P&L</Th>
                  <Th right>Stop Loss</Th>
                  <Th right>Take Profit</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {livePositions.map(pos => {
                  const pnlPos = (pos.pnl ?? 0) >= 0
                  const pnlCls = pos.pnl != null ? (pnlPos ? 'text-buy' : 'text-sell') : 'text-muted'
                  const coin = pos.coin.replace('/USDC', '')
                  const slPct = pos.distance_to_sl_pct
                  const tpPct = pos.distance_to_tp_pct
                  return (
                    <tr key={pos.id} className="hover:bg-surface-elevated/50 transition-colors duration-100">
                      <Td>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{coin}</span>
                          <span className={cn(
                            'text-xs px-1.5 py-0.5 rounded-md font-medium',
                            pos.status === 'OPEN' ? 'bg-buy/10 text-buy' : 'bg-muted/10 text-muted',
                          )}>
                            {pos.status}
                          </span>
                        </div>
                      </Td>
                      <Td right>{fmt(pos.quantity, 6)}</Td>
                      <Td right>{fmtUSD(pos.entry_price)}</Td>
                      <Td right>{pos.current_price != null ? fmtUSD(pos.current_price) : '—'}</Td>
                      <Td right className={pnlCls}>
                        {pos.pnl != null ? (
                          <div>
                            <div className="font-medium">{pnlPos ? '+' : ''}{fmtUSD(pos.pnl)}</div>
                            {pos.pnl_pct != null && <div className="text-xs opacity-75">{fmtPct(pos.pnl_pct)}</div>}
                          </div>
                        ) : '—'}
                      </Td>
                      <Td right>
                        <div>
                          <div className="font-medium">{fmtUSD(pos.stop_loss)}</div>
                          {slPct != null && (
                            <div className={cn('text-xs', slPct < 2 ? 'text-sell font-semibold' : 'text-muted')}>
                              {slPct.toFixed(1)}% away
                            </div>
                          )}
                        </div>
                      </Td>
                      <Td right>
                        {pos.take_profit != null ? (
                          <div>
                            <div className="font-medium">{fmtUSD(pos.take_profit)}</div>
                            {tpPct != null && (
                              <div className="text-xs text-buy">+{tpPct.toFixed(1)}%</div>
                            )}
                          </div>
                        ) : <span className="text-muted">—</span>}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Holdings ──────────────────────────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader
            title="Holdings"
            subtitle={`${holdings.length} coin${holdings.length !== 1 ? 's' : ''} — all sources`}
            action={
              <Button variant="secondary" size="sm" onClick={() => setTransferOpen(true)}>
                Transfer
              </Button>
            }
          />
        </div>

        {holdings.length === 0 ? (
          <div className="px-5 pb-6 text-center text-sm text-muted">
            No holdings — deposit USDC and let the bot trade, or transfer a coin from Binance.
          </div>
        ) : (
          <div className="overflow-x-auto pb-1">
            <table className="w-full text-sm min-w-[680px]">
              <thead>
                <tr className="border-b border-border">
                  <Th>Coin</Th>
                  <Th>Source</Th>
                  <Th right>Qty</Th>
                  <Th right>Cost Basis</Th>
                  <Th right>Current</Th>
                  <Th right>Value</Th>
                  <Th right>P&L</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {holdings.map(h => {
                  const up = h.delta_pct != null && h.delta_pct >= 0
                  const pnlCls = h.delta_pct != null ? (up ? 'text-buy' : 'text-sell') : 'text-muted'
                  const value = h.current_price != null ? h.current_price * h.quantity : null
                  return (
                    <tr key={h.id} className="hover:bg-surface-elevated/50 transition-colors duration-100">
                      <Td><span className="font-semibold">{h.coin.replace('/USDC', '')}</span></Td>
                      <Td><SourceBadge source={h.source} /></Td>
                      <Td right>{fmt(h.quantity, 6)}</Td>
                      <Td right>{h.buy_price ? fmtUSD(h.buy_price) : '—'}</Td>
                      <Td right>{h.current_price != null ? fmtUSD(h.current_price) : '—'}</Td>
                      <Td right className="font-medium">{value != null ? fmtUSD(value) : '—'}</Td>
                      <Td right className={pnlCls}>
                        {h.delta_usd != null ? (
                          <div>
                            <div className="font-medium">{up ? '+' : ''}{fmtUSD(h.delta_usd)}</div>
                            {h.delta_pct != null && <div className="text-xs opacity-75">{fmtPct(h.delta_pct)}</div>}
                          </div>
                        ) : '—'}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── USDC Balance ──────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">USDC Balance</h3>
            <p className="text-xs text-muted mt-0.5">Local: {fmtUSD(usdcBalance)}</p>
            {portfolio?.binance_usdc != null && (
              <p className="text-xs text-muted mt-0.5">
                Binance: {fmtUSD(portfolio.binance_usdc)}
                <span className="mx-1.5 text-border">·</span>
                Available: {fmtUSD(portfolio.available_usdc ?? 0)}
              </p>
            )}
          </div>
        </div>
        <div className="space-y-3">
          <Input
            label="Amount (USDC)"
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={e => { setAmount(e.target.value); setTxError(null) }}
            placeholder="0.00"
            error={txError ?? undefined}
          />
          <div className="flex gap-2">
            <Button variant="success" size="md" loading={txPending === 'deposit'} disabled={txPending !== null} onClick={() => handleTransaction('deposit')} className="flex-1">
              Deposit
            </Button>
            <Button variant="danger" size="md" loading={txPending === 'withdraw'} disabled={txPending !== null} onClick={() => handleTransaction('withdraw')} className="flex-1">
              Withdraw
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Final Gains ───────────────────────────────────────────────── */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader
            title="Final Gains"
            subtitle="Realized P&L from completed USDC → coin → USDC round trips"
            action={gains && gains.coins.length > 0 ? (
              <div className="text-right">
                <div className={cn('text-lg font-bold tabular-nums', gains.total_pnl >= 0 ? 'text-buy' : 'text-sell')}>
                  {gains.total_pnl >= 0 ? '+' : ''}{fmtUSD(gains.total_pnl)}
                </div>
                <div className="text-xs text-muted tabular-nums">fees: {fmtUSD(gains.total_fees ?? 0)}</div>
              </div>
            ) : undefined}
          />
        </div>

        {!gains || gains.coins.length === 0 ? (
          <div className="px-5 pb-6 text-center text-sm text-muted">
            No completed round trips yet — sell a position to see realized gains here.
          </div>
        ) : (
          <div className="overflow-x-auto pb-1">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="border-b border-border">
                  {['Coin', 'Invested', 'Returned', 'Fees', 'P&L', '%'].map((h, i) => (
                    <th key={h} className={cn('py-2.5 px-4 text-xs font-medium text-muted uppercase tracking-wide', i === 0 ? 'text-left' : 'text-right')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {gains.coins.map(c => {
                  const pos = c.realized_pnl >= 0
                  const cls = pos ? 'text-buy' : 'text-sell'
                  return (
                    <tr key={c.coin} className="hover:bg-surface-elevated/50 transition-colors duration-100">
                      <td className="py-3 px-4 font-semibold">{c.coin.replace('/USDC', '')}</td>
                      <td className="py-3 px-4 text-right tabular-nums text-muted">{fmtUSD(c.total_bought)}</td>
                      <td className="py-3 px-4 text-right tabular-nums text-muted">{fmtUSD(c.total_sold)}</td>
                      <td className="py-3 px-4 text-right tabular-nums text-sell">{fmtUSD(c.fees_paid ?? 0)}</td>
                      <td className={cn('py-3 px-4 text-right tabular-nums font-semibold', cls)}>
                        {pos ? '+' : ''}{fmtUSD(c.realized_pnl)}
                      </td>
                      <td className={cn('py-3 px-4 text-right tabular-nums font-medium', cls)}>
                        {pos ? '+' : ''}{c.pnl_pct.toFixed(2)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <TransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        onSuccess={load}
        localEntries={portfolio?.entries ?? []}
      />
    </div>
  )
}
