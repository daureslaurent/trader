interface Trade {
  id: number
  coin: string
  side: string
  quantity: number
  price_usd: number
  total_usd: number
  status: string
  created_at: string
}

export default function TradeHistory({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) return <p className="text-gray-500 text-sm">No trades yet.</p>

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-400 border-b border-gray-800">
            <th className="text-left py-2">Time</th>
            <th className="text-left">Coin</th>
            <th className="text-left">Side</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Price</th>
            <th className="text-right">Total</th>
            <th className="text-center">Status</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-b border-gray-800/50">
              <td className="py-2 text-gray-400">{new Date(t.created_at).toLocaleTimeString()}</td>
              <td>{t.coin.replace('/USDT', '')}</td>
              <td className={t.side === 'BUY' ? 'text-green-400' : 'text-red-400'}>{t.side}</td>
              <td className="text-right">{t.quantity}</td>
              <td className="text-right">${t.price_usd?.toFixed(2) ?? '-'}</td>
              <td className="text-right">${t.total_usd?.toFixed(2) ?? '-'}</td>
              <td className="text-center">
                <span className={`px-2 py-0.5 rounded text-xs ${
                  t.status === 'EXECUTED' ? 'bg-green-900/50 text-green-400' :
                  t.status === 'FAILED' ? 'bg-red-900/50 text-red-400' :
                  'bg-yellow-900/50 text-yellow-400'
                }`}>{t.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
