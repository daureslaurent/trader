import { useEffect, useState } from 'react'

interface PortfolioData {
  total_value_usd: number
  holdings: Record<string, number>
  open_position_count: number
  max_open_positions: number
}

interface PositionData {
  id: number
  coin: string
  quantity: number
  entry_price: number
  current_price: number | null
  pnl: number | null
  pnl_pct: number | null
  stop_loss: number | null
  take_profit: number | null
  distance_to_sl_pct: number | null
  distance_to_tp_pct: number | null
  status: string
}

export default function Portfolio() {
  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null)
  const [positions, setPositions] = useState<PositionData[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/portfolio').then(r => r.json()),
      fetch('/api/positions').then(r => r.json()),
    ]).then(([p, pos]) => {
      setPortfolio(p)
      setPositions(pos)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="text-gray-500">Loading...</p>

  const holdings = Object.entries(portfolio?.holdings || {}).filter(([, v]) => v > 0)

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">Total Value</div>
          <div className="text-3xl font-bold text-green-400">${portfolio?.total_value_usd.toFixed(2) || '0.00'}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">Open Positions</div>
          <div className="text-3xl font-bold text-white">
            {portfolio?.open_position_count || 0} <span className="text-sm text-gray-500">/ {portfolio?.max_open_positions || 5}</span>
          </div>
        </div>
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">Holdings Count</div>
          <div className="text-3xl font-bold text-white">{holdings.length}</div>
        </div>
      </div>

      <div className="bg-gray-900 rounded-lg p-4 mb-6">
        <h2 className="text-lg font-semibold mb-3">Positions</h2>
        {positions.length === 0 ? (
          <p className="text-gray-500 text-sm">No open positions. Start trading!</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 border-b border-gray-800">
                  <th className="text-left py-2 pr-4">Coin</th>
                  <th className="text-right py-2 pr-4">Size</th>
                  <th className="text-right py-2 pr-4">Entry</th>
                  <th className="text-right py-2 pr-4">Current</th>
                  <th className="text-right py-2 pr-4">PnL</th>
                  <th className="text-right py-2 pr-4">Stop Loss</th>
                  <th className="text-right py-2 pr-4">Take Profit</th>
                  <th className="text-right py-2 pr-4">to SL</th>
                  <th className="text-right py-2">to TP</th>
                </tr>
              </thead>
              <tbody>
                {positions.map(p => {
                  const isPositive = p.pnl_pct !== null && p.pnl_pct >= 0
                  return (
                    <tr key={p.id} className="border-b border-gray-800 hover:bg-gray-800/40">
                      <td className="py-3 pr-4 font-medium">{p.coin}</td>
                      <td className="text-right py-3 pr-4">{p.quantity}</td>
                      <td className="text-right py-3 pr-4">${p.entry_price.toFixed(2)}</td>
                      <td className="text-right py-3 pr-4">{p.current_price ? `$${p.current_price.toFixed(2)}` : '—'}</td>
                      <td className={`text-right py-3 pr-4 font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                        {p.pnl_pct !== null ? `${p.pnl_pct > 0 ? '+' : ''}${p.pnl_pct.toFixed(2)}%` : '—'}
                      </td>
                      <td className="text-right py-3 pr-4 text-red-400">{p.stop_loss ? `$${p.stop_loss.toFixed(2)}` : '—'}</td>
                      <td className="text-right py-3 pr-4 text-green-400">{p.take_profit ? `$${p.take_profit.toFixed(2)}` : '—'}</td>
                      <td className="text-right py-3 pr-4">{p.distance_to_sl_pct !== null ? `${p.distance_to_sl_pct.toFixed(1)}%` : '—'}</td>
                      <td className="text-right py-3">{p.distance_to_tp_pct !== null ? `${p.distance_to_tp_pct.toFixed(1)}%` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Holdings (Balance)</h2>
        {holdings.length === 0 ? (
          <p className="text-gray-500 text-sm">No holdings. Start trading!</p>
        ) : (
          <div className="space-y-2">
            {holdings.map(([coin, amount]) => (
              <div key={coin} className="flex justify-between items-center border-b border-gray-800 pb-2">
                <span className="font-medium">{coin}</span>
                <span className="text-gray-300">{amount.toFixed(6)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
