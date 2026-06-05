import { useEffect, useState } from 'react'

interface PortfolioEntryUI {
  id: number
  coin: string
  quantity: number
  buy_price: number
  buy_date: string
  current_price: number | null
  delta_usd: number | null
  delta_pct: number | null
  status: string
}

interface PortfolioData {
  total_value_usd: number
  entries: PortfolioEntryUI[]
  usdt_balance: number
  open_position_count: number
}

export default function Portfolio() {
  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null)
  const [positions, setPositions] = useState<PortfolioEntryUI[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/portfolio')
      .then(r => r.json())
      .then(p => {
        setPortfolio(p)
        setPositions(p.entries || [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="text-gray-500">Loading...</p>

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">Total Value</div>
          <div className="text-3xl font-bold text-green-400">${portfolio?.total_value_usd.toFixed(2) || '0.00'}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">Open Positions</div>
          <div className="text-3xl font-bold text-white">{portfolio?.open_position_count || 0}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-gray-400 text-sm">USDT Balance</div>
          <div className="text-3xl font-bold text-white">${portfolio?.usdt_balance?.toFixed(2) || '0.00'}</div>
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
                  <th className="text-right py-2 pr-4">Qty</th>
                  <th className="text-right py-2 pr-4">Buy Date</th>
                  <th className="text-right py-2 pr-4">Buy Price</th>
                  <th className="text-right py-2 pr-4">Current</th>
                  <th className="text-right py-2 pr-4">Delta $</th>
                  <th className="text-right py-2">Delta %</th>
                </tr>
              </thead>
              <tbody>
                {positions.map(p => {
                  const isPositive = p.delta_pct !== null && p.delta_pct >= 0
                  return (
                    <tr key={p.id} className="border-b border-gray-800 hover:bg-gray-800/40">
                      <td className="py-3 pr-4 font-medium">{p.coin}</td>
                      <td className="text-right py-3 pr-4">{p.quantity}</td>
                      <td className="text-right py-3 pr-4">{p.buy_date}</td>
                      <td className="text-right py-3 pr-4">${p.buy_price.toFixed(2)}</td>
                      <td className="text-right py-3 pr-4">{p.current_price ? `$${p.current_price.toFixed(2)}` : '—'}</td>
                      <td className={`text-right py-3 pr-4 font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                        {p.delta_usd !== null ? `${p.delta_usd > 0 ? '+' : ''}$${p.delta_usd.toFixed(2)}` : '—'}
                      </td>
                      <td className={`text-right py-3 font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                        {p.delta_pct !== null ? `${p.delta_pct > 0 ? '+' : ''}${p.delta_pct.toFixed(2)}%` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Cash</h2>
        <div className="flex justify-between items-center border-b border-gray-800 pb-2">
          <span className="font-medium">USDT</span>
          <span className="text-gray-300">${portfolio?.usdt_balance?.toFixed(2) || '0.00'}</span>
        </div>
      </div>
    </div>
  )
}
