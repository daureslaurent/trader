import { useEffect, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'

interface Decision {
  id: number
  coin: string
  action: string
  reason: string
  confidence: number
  context: string
  created_at: string
}

interface Trade {
  id: number
  coin: string
  side: string
  quantity: number
  price: number
  total: number
  status: string
  created_at: string
}

type LogEntry =
  | { type: 'decision'; data: Decision; ts: string }
  | { type: 'trade'; data: Trade; ts: string }
  | { type: 'approval'; data: { tradeId: number; coin: string; side: string; quantity: number; reason: string; confidence: number }; ts: string }
  | { type: 'portfolio'; data: { total_value_usd: number }; ts: string }

export default function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([])

  useEffect(() => {
    Promise.all([
      fetch('/api/decisions').then((r) => r.json()).catch(() => []),
      fetch('/api/trades').then((r) => r.json()).catch(() => []),
    ]).then(([decisions, trades]) => {
      const all: LogEntry[] = [
        ...(decisions as Decision[]).map((d) => ({ type: 'decision' as const, data: d, ts: d.created_at })),
        ...(trades as Trade[]).map((t) => ({ type: 'trade' as const, data: t, ts: t.created_at })),
      ]
      all.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      setEntries(all)
    })
  }, [])

  useWebSocket((msg) => {
    if (msg.type === 'trade_executed') {
      const trade = msg.data as Trade
      setEntries((prev) => [{ type: 'trade', data: trade, ts: trade.created_at }, ...prev])
    } else if (msg.type === 'portfolio_updated') {
      setEntries((prev) => [{ type: 'portfolio', data: { total_value_usd: 0 }, ts: new Date().toISOString() }, ...prev])
    } else if (msg.type === 'approval_requested') {
      const a = msg.data as { tradeId: number; coin: string; side: string; quantity: number; reason: string; confidence: number; expiresAt: string }
      setEntries((prev) => [{ type: 'approval', data: a, ts: new Date().toISOString() }, ...prev])
    }
  })

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Activity Log</h2>
      <div className="space-y-2 max-h-[70vh] overflow-y-auto">
        {entries.length === 0 && <p className="text-gray-500 text-sm">No activity yet.</p>}
        {entries.map((entry, i) => (
          <div key={entry.ts + '-' + ((entry.data as any).id ?? i)} className="bg-gray-900 rounded px-3 py-2 text-sm flex items-start gap-3">
            <span className="text-xs text-gray-500 whitespace-nowrap mt-0.5 w-16 shrink-0">
              {new Date(entry.ts).toLocaleTimeString()}
            </span>

            {entry.type === 'decision' && (
              <>
                <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                  entry.data.action === 'BUY' ? 'bg-green-900/50 text-green-400' :
                  entry.data.action === 'SELL' ? 'bg-red-900/50 text-red-400' :
                  'bg-gray-700 text-gray-300'
                }`}>{entry.data.action}</span>
                <span className="text-gray-200">{entry.data.coin.replace('/USDT', '')}</span>
                <span className="text-gray-400 truncate flex-1">{entry.data.reason}</span>
                <span className="text-gray-500 text-xs">{(entry.data.confidence * 100).toFixed(0)}%</span>
              </>
            )}

            {entry.type === 'trade' && (
              <>
                <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                  entry.data.status === 'EXECUTED' ? 'bg-green-900/50 text-green-400' :
                  entry.data.status === 'FAILED' ? 'bg-red-900/50 text-red-400' :
                  'bg-yellow-900/50 text-yellow-400'
                }`}>{entry.data.status}</span>
                <span className="text-gray-200">{entry.data.coin.replace('/USDT', '')}</span>
                <span className={entry.data.side === 'BUY' ? 'text-green-400' : 'text-red-400'}>
                  {entry.data.side} {entry.data.quantity}
                </span>
                {entry.data.price && (
                  <span className="text-gray-400">@ ${entry.data.price.toFixed(2)}</span>
                )}
              </>
            )}

            {entry.type === 'approval' && (
              <>
                <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-yellow-900/50 text-yellow-400">APPROVAL</span>
                <span className="text-yellow-300">{entry.data.side} {entry.data.quantity} {entry.data.coin.replace('/USDT', '')}</span>
                <span className="text-gray-400 truncate flex-1">{entry.data.reason}</span>
              </>
            )}

            {entry.type === 'portfolio' && (
              <>
                <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-900/50 text-blue-400">SNAPSHOT</span>
                <span className="text-gray-400">Portfolio snapshot taken</span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
