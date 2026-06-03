import { useEffect, useState } from 'react'

interface PortfolioData {
  total_value_usd: number
  holdings: Record<string, number>
}

export default function Portfolio() {
  const [data, setData] = useState<PortfolioData | null>(null)

  useEffect(() => {
    fetch('/api/portfolio').then((r) => r.json()).then(setData).catch(() => {})
  }, [])

  if (!data) return <p className="text-gray-500">Loading...</p>

  const holdings = Object.entries(data.holdings || {}).filter(([, v]) => v > 0)

  return (
    <div>
      <div className="bg-gray-900 rounded-lg p-4 mb-6">
        <div className="text-gray-400 text-sm">Total Portfolio Value</div>
        <div className="text-3xl font-bold text-green-400">${data.total_value_usd.toFixed(2)}</div>
      </div>

      <div className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Holdings</h2>
        {holdings.length === 0 ? (
          <p className="text-gray-500 text-sm">No holdings. Start trading!</p>
        ) : (
          <div className="space-y-2">
            {holdings.map(([coin, amount]) => (
              <div key={coin} className="flex justify-between items-center border-b border-gray-800 pb-2">
                <span className="font-medium">{coin}</span>
                <span className="text-gray-300">{amount}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
