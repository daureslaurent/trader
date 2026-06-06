import { Trade } from '../types'
import { actionBadge, statusBadge } from './ui/Badge'
import { fmtUSD, fmt, formatDate } from '../lib/utils'

export function TradeHistory({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) {
    return <p className="text-sm text-muted py-6 text-center">No trades recorded yet.</p>
  }

  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm min-w-[600px]">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2.5 px-3 text-xs font-medium text-muted uppercase tracking-wide">Time</th>
            <th className="text-left px-3 text-xs font-medium text-muted uppercase tracking-wide">Coin</th>
            <th className="text-left px-3 text-xs font-medium text-muted uppercase tracking-wide">Side</th>
            <th className="text-right px-3 text-xs font-medium text-muted uppercase tracking-wide">Qty</th>
            <th className="text-right px-3 text-xs font-medium text-muted uppercase tracking-wide">Price</th>
            <th className="text-right px-3 text-xs font-medium text-muted uppercase tracking-wide">Total</th>
            <th className="text-center px-3 text-xs font-medium text-muted uppercase tracking-wide">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {trades.map(t => (
            <tr key={t.id} className="hover:bg-surface-elevated/50 transition-colors duration-100">
              <td className="py-3 px-3 text-xs text-muted font-mono">{formatDate(t.created_at)}</td>
              <td className="px-3 font-medium">{t.coin.replace('/USDC', '')}</td>
              <td className="px-3">{actionBadge(t.side)}</td>
              <td className="px-3 text-right tabular-nums">{fmt(t.quantity, 6)}</td>
              <td className="px-3 text-right tabular-nums">{t.price ? fmtUSD(t.price) : '—'}</td>
              <td className="px-3 text-right tabular-nums">{t.total ? fmtUSD(t.total) : '—'}</td>
              <td className="px-3 text-center">{statusBadge(t.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
