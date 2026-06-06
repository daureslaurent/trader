import { useEffect, useState } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Stat } from '../components/ui/Stat'
import { Input } from '../components/ui/Input'
import { PortfolioEntry, PortfolioResponse } from '../types'
import { fmtUSD, fmtPct, fmt } from '../lib/utils'
import { cn } from '../lib/utils'

const WalletIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
  </svg>
)

export default function Portfolio() {
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState('')
  const [txError, setTxError] = useState<string | null>(null)
  const [txPending, setTxPending] = useState<'deposit' | 'withdraw' | null>(null)

  function load() {
    setLoading(true)
    fetch('/api/portfolio').then(r => r.json()).then(setPortfolio).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const usdtBalance = portfolio?.entries.find(e => e.coin === 'USDC')?.quantity ?? 0
  const positions: PortfolioEntry[] = portfolio?.entries.filter(e => e.coin !== 'USDC') ?? []

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
      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Stat label="Total Value" value={fmtUSD(portfolio?.total_value ?? 0)} icon={<WalletIcon />} />
        <Stat label="USDC Available" value={fmtUSD(usdtBalance)} trend="neutral" />
        <Stat label="Open Positions" value={positions.length} />
      </div>

      {/* USDC balance management */}
      <Card>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">USDC Balance</h3>
            <p className="text-xs text-muted mt-0.5">Current: {fmtUSD(usdtBalance)}</p>
            {portfolio?.binance_usdc !== null && portfolio?.binance_usdc !== undefined && (
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
            <Button
              variant="success"
              size="md"
              loading={txPending === 'deposit'}
              disabled={txPending !== null}
              onClick={() => handleTransaction('deposit')}
              className="flex-1"
            >
              Deposit
            </Button>
            <Button
              variant="danger"
              size="md"
              loading={txPending === 'withdraw'}
              disabled={txPending !== null}
              onClick={() => handleTransaction('withdraw')}
              className="flex-1"
            >
              Withdraw
            </Button>
          </div>
        </div>
      </Card>

      {/* Positions table */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader title="Holdings" subtitle={`${positions.length} open position${positions.length !== 1 ? 's' : ''}`} />
        </div>

        {positions.length === 0 ? (
          <div className="px-5 pb-6 text-center text-sm text-muted">No open positions — start trading to see them here.</div>
        ) : (
          <div className="overflow-x-auto pb-1">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-border">
                  {['Coin', 'Qty', 'Value (USDC)', 'Buy Date', 'Buy Price', 'Current', 'Delta $', 'Delta %'].map((h, i) => (
                    <th key={h} className={cn(
                      'py-2.5 px-4 text-xs font-medium text-muted uppercase tracking-wide',
                      i === 0 ? 'text-left' : 'text-right',
                    )}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {positions.map(p => {
                  const up = p.delta_pct != null && p.delta_pct >= 0
                  const dClass = up ? 'text-buy' : 'text-sell'
                  return (
                    <tr key={p.id} className="hover:bg-surface-elevated/50 transition-colors duration-100">
                      <td className="py-3 px-4 font-semibold">{p.coin.replace('/USDC', '')}</td>
                      <td className="py-3 px-4 text-right tabular-nums">{fmt(p.quantity, 6)}</td>
                      <td className="py-3 px-4 text-right tabular-nums font-medium">
                        {p.current_price != null ? fmtUSD(p.current_price * p.quantity) : '—'}
                      </td>
                      <td className="py-3 px-4 text-right text-muted text-xs">{p.buy_date}</td>
                      <td className="py-3 px-4 text-right tabular-nums">{p.buy_price ? fmtUSD(p.buy_price) : '—'}</td>
                      <td className="py-3 px-4 text-right tabular-nums">{p.current_price ? fmtUSD(p.current_price) : '—'}</td>
                      <td className={cn('py-3 px-4 text-right tabular-nums font-medium', dClass)}>
                        {p.delta_usd != null ? (p.delta_usd >= 0 ? '+' : '') + fmtUSD(p.delta_usd) : '—'}
                      </td>
                      <td className={cn('py-3 px-4 text-right tabular-nums font-medium', dClass)}>
                        {p.delta_pct != null ? fmtPct(p.delta_pct) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
