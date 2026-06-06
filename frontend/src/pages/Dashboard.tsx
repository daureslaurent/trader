import { useEffect, useState, useCallback } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { TradeApproval } from '../components/TradeApproval'
import { TradeHistory } from '../components/TradeHistory'
import { Stat } from '../components/ui/Stat'
import { Card, CardHeader } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { ApprovalRequest, Trade } from '../types'
import { fmtUSD } from '../lib/utils'

interface PortfolioData {
  total_value?: number
  open_position_count?: number
  max_open_positions?: number
}

interface Alert {
  id: number
  type: 'SL' | 'TP'
  coin: string
  price: number
}

interface Props {
  onApprovalAction?: () => void
}

const PortfolioIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33" />
  </svg>
)

const PositionIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148A12.061 12.061 0 0116.5 7.605" />
  </svg>
)

const TradeIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
  </svg>
)

const PendingIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
)

export default function Dashboard({ onApprovalAction }: Props) {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [trades, setTrades] = useState<Trade[]>([])
  const [portfolio, setPortfolio] = useState<PortfolioData>({})
  const [alerts, setAlerts] = useState<Alert[]>([])

  function loadData() {
    fetch('/api/portfolio').then(r => r.json()).then(setPortfolio).catch(() => {})
    fetch('/api/trades').then(r => r.json()).then(setTrades).catch(() => {})
  }

  useEffect(() => { loadData() }, [])

  useWebSocket(useCallback((event: string, data: unknown) => {
    if (event === 'approval_requested') {
      setApprovals(prev => [...prev, data as ApprovalRequest])
    } else if (event === 'stop_loss_hit') {
      const d = data as { coin: string; price: number }
      setAlerts(prev => [{ id: Date.now(), type: 'SL' as const, coin: d.coin, price: d.price }, ...prev].slice(0, 5))
      loadData()
    } else if (event === 'take_profit_hit') {
      const d = data as { coin: string; price: number }
      setAlerts(prev => [{ id: Date.now(), type: 'TP' as const, coin: d.coin, price: d.price }, ...prev].slice(0, 5))
      loadData()
    } else if (event === 'trade_executed' || event === 'portfolio_updated') {
      loadData()
    } else if (event === 'trade_rejected') {
      const id = data as number
      setApprovals(prev => prev.filter(a => a.tradeId !== id))
    }
  }, []))

  function handleApprovalAction(tradeId: number) {
    setApprovals(prev => prev.filter(a => a.tradeId !== tradeId))
    onApprovalAction?.()
    loadData()
  }

  const totalValue = portfolio.total_value ?? 0
  const openPositions = portfolio.open_position_count ?? 0
  const maxPositions = portfolio.max_open_positions ?? 5

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map(a => (
            <div
              key={a.id}
              className={`flex items-center justify-between px-4 py-3 rounded-xl border text-sm ${
                a.type === 'SL'
                  ? 'bg-sell/5 border-sell/20 text-sell'
                  : 'bg-buy/5 border-buy/20 text-buy'
              }`}
            >
              <div className="flex items-center gap-2">
                <Badge variant={a.type === 'SL' ? 'sell' : 'executed'} dot>
                  {a.type === 'SL' ? 'Stop Loss' : 'Take Profit'}
                </Badge>
                <span className="text-foreground">{a.coin.replace('/USDC', '')} at {fmtUSD(a.price)}</span>
              </div>
              <button
                onClick={() => setAlerts(prev => prev.filter(x => x.id !== a.id))}
                className="text-muted hover:text-foreground transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat
          label="Portfolio Value"
          value={fmtUSD(totalValue)}
          icon={<PortfolioIcon />}
        />
        <Stat
          label="Bot Positions"
          value={`${openPositions} / ${maxPositions}`}
          sub={openPositions >= maxPositions ? 'limit reached' : `${maxPositions - openPositions} slots free`}
          icon={<PositionIcon />}
        />
        <Stat
          label="Total Trades"
          value={trades.length}
          icon={<TradeIcon />}
        />
        <Stat
          label="Pending Approval"
          value={approvals.length}
          icon={<PendingIcon />}
          trend={approvals.length > 0 ? 'down' : 'neutral'}
        />
      </div>

      {/* Approvals */}
      {approvals.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            Pending Approvals
            <Badge variant="warning">{approvals.length}</Badge>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {approvals.map(a => (
              <TradeApproval
                key={a.tradeId}
                request={a}
                onAction={() => handleApprovalAction(a.tradeId)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Recent trades */}
      <Card noPad>
        <div className="px-5 pt-5 pb-4">
          <CardHeader title="Recent Trades" subtitle={`${trades.length} total`} />
        </div>
        <div className="px-5 pb-5">
          <TradeHistory trades={trades.slice(0, 20)} />
        </div>
      </Card>
    </div>
  )
}
