import { useEffect, useState, useCallback } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import TradeApproval from '../components/TradeApproval'
import TradeHistory from '../components/TradeHistory'

interface ApprovalData {
  tradeId: number
  coin: string
  side: 'BUY' | 'SELL'
  quantity: number
  estimatedPrice: number
  reason: string
  confidence: number
  expiresAt: string
}

interface PortfolioData {
  total_value_usd: number
  open_position_count: number
  max_open_positions: number
}

interface WsMsg {
  type: string
  data: unknown
}

interface AlertEvent {
  coin: string
  price: number
  pnl: number | null
}

export default function Dashboard() {
  const [approvals, setApprovals] = useState<ApprovalData[]>([])
  const [trades, setTrades] = useState([])
  const [portfolio, setPortfolio] = useState<PortfolioData>({ total_value_usd: 0, open_position_count: 0, max_open_positions: 5 })
  const [alerts, setAlerts] = useState<{ type: 'SL' | 'TP'; coin: string; price: number; id: number }[]>([])

  useEffect(() => {
    fetch('/api/portfolio').then(r => r.json()).then(setPortfolio).catch(() => {})
    fetch('/api/trades').then(r => r.json()).then(setTrades).catch(() => {})
  }, [])

  useWebSocket(useCallback((msg: WsMsg) => {
    if (msg.type === 'approval_requested') {
      setApprovals(prev => [...prev, msg.data as ApprovalData])
    } else if (msg.type === 'stop_loss_hit') {
      const d = msg.data as AlertEvent
      setAlerts(prev => [{ type: 'SL' as const, coin: d.coin, price: d.price, id: Date.now() }, ...prev].slice(0, 5))
      fetch('/api/trades').then(r => r.json()).then(setTrades).catch(() => {})
      fetch('/api/portfolio').then(r => r.json()).then(setPortfolio).catch(() => {})
    } else if (msg.type === 'take_profit_hit') {
      const d = msg.data as AlertEvent
      setAlerts(prev => [{ type: 'TP' as const, coin: d.coin, price: d.price, id: Date.now() }, ...prev].slice(0, 5))
      fetch('/api/trades').then(r => r.json()).then(setTrades).catch(() => {})
      fetch('/api/portfolio').then(r => r.json()).then(setPortfolio).catch(() => {})
    } else if (msg.type === 'trade_executed' || msg.type === 'portfolio_updated') {
      fetch('/api/trades').then(r => r.json()).then(setTrades).catch(() => {})
      fetch('/api/portfolio').then(r => r.json()).then(setPortfolio).catch(() => {})
    }
  }, []))

  const handleApprove = async (id: number) => {
    await fetch(`/api/trade/approve/${id}`, { method: 'POST' })
    setApprovals(prev => prev.filter(a => a.tradeId !== id))
  }

  const handleReject = async (id: number) => {
    await fetch(`/api/trade/reject/${id}`, { method: 'POST' })
    setApprovals(prev => prev.filter(a => a.tradeId !== id))
  }

  const dismissAlert = (id: number) => setAlerts(prev => prev.filter(a => a.id !== id))

  return (
    <div>
      {alerts.length > 0 && (
        <div className="mb-4 space-y-2">
          {alerts.map(a => (
            <div key={a.id} className={`flex items-center justify-between px-4 py-2 rounded-lg text-sm ${
              a.type === 'SL' ? 'bg-red-900/40 border border-red-500/30 text-red-300' : 'bg-green-900/40 border border-green-500/30 text-green-300'
            }`}>
              <span>{a.type === 'SL' ? '🛑 Stop Loss' : '✅ Take Profit'} triggered for {a.coin} at ${a.price.toFixed(2)}</span>
              <button onClick={() => dismissAlert(a.id)} className="ml-3 text-gray-400 hover:text-white">&times;</button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">Portfolio Value</div>
          <div className="text-2xl font-bold text-green-400">${portfolio.total_value_usd.toFixed(2)}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">Open Positions</div>
          <div className="text-2xl font-bold text-white">{portfolio.open_position_count} <span className="text-sm text-gray-500">/ {portfolio.max_open_positions}</span></div>
        </div>
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">Trades Today</div>
          <div className="text-2xl font-bold text-white">{trades.length}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">Pending Approvals</div>
          <div className="text-2xl font-bold text-yellow-400">{approvals.length}</div>
        </div>
      </div>

      {approvals.map(a => (
        <TradeApproval
          key={a.tradeId}
          tradeId={a.tradeId}
          coin={a.coin}
          side={a.side}
          quantity={a.quantity}
          reason={a.reason}
          confidence={a.confidence}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      ))}

      <div className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Recent Trades</h2>
        <TradeHistory trades={trades} />
      </div>
    </div>
  )
}
