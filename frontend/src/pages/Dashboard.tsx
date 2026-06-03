import { useEffect, useState } from 'react'
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

export default function Dashboard() {
  const [approvals, setApprovals] = useState<ApprovalData[]>([])
  const [trades, setTrades] = useState([])
  const [portfolio, setPortfolio] = useState({ total_value_usd: 0 })

  useEffect(() => {
    fetch('/api/portfolio').then((r) => r.json()).then(setPortfolio).catch(() => {})
    fetch('/api/trades').then((r) => r.json()).then(setTrades).catch(() => {})
  }, [])

  useWebSocket((msg) => {
    if (msg.type === 'approval_requested') {
      setApprovals((prev) => [...prev, msg.data as ApprovalData])
    } else if (msg.type === 'trade_executed' || msg.type === 'portfolio_updated') {
      fetch('/api/trades').then((r) => r.json()).then(setTrades).catch(() => {})
      fetch('/api/portfolio').then((r) => r.json()).then(setPortfolio).catch(() => {})
    }
  })

  const handleApprove = async (id: number) => {
    await fetch(`/api/trade/approve/${id}`, { method: 'POST' })
    setApprovals((prev) => prev.filter((a) => a.tradeId !== id))
  }

  const handleReject = async (id: number) => {
    await fetch(`/api/trade/reject/${id}`, { method: 'POST' })
    setApprovals((prev) => prev.filter((a) => a.tradeId !== id))
  }

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">Portfolio Value</div>
          <div className="text-2xl font-bold text-green-400">${portfolio.total_value_usd.toFixed(2)}</div>
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

      {approvals.map((a) => (
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
