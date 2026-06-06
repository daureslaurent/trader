import { useEffect, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { Decision, Trade, ApprovalRequest } from '../types'
import { actionBadge, statusBadge, Badge } from '../components/ui/Badge'
import { fmtUSD, fmt, formatDate } from '../lib/utils'

type LogEntry =
  | { kind: 'decision'; data: Decision; ts: string }
  | { kind: 'trade'; data: Trade; ts: string }
  | { kind: 'approval'; data: ApprovalRequest; ts: string }
  | { kind: 'snapshot'; ts: string }

export default function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([])

  useEffect(() => {
    Promise.all([
      fetch('/api/decisions').then(r => r.json()).catch(() => []),
      fetch('/api/trades').then(r => r.json()).catch(() => []),
    ]).then(([decisions, trades]) => {
      const all: LogEntry[] = [
        ...(decisions as Decision[]).map(d => ({ kind: 'decision' as const, data: d, ts: d.created_at })),
        ...(trades as Trade[]).map(t => ({ kind: 'trade' as const, data: t, ts: t.created_at })),
      ]
      all.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      setEntries(all)
    })
  }, [])

  useWebSocket((event, data) => {
    if (event === 'trade_executed') {
      const trade = data as Trade
      setEntries(prev => [{ kind: 'trade', data: trade, ts: trade.created_at }, ...prev])
    } else if (event === 'portfolio_updated') {
      setEntries(prev => [{ kind: 'snapshot', ts: new Date().toISOString() }, ...prev])
    } else if (event === 'approval_requested') {
      setEntries(prev => [{ kind: 'approval', data: data as ApprovalRequest, ts: new Date().toISOString() }, ...prev])
    }
  })

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Activity Feed</h2>
          <p className="text-xs text-muted mt-0.5">{entries.length} events — live via WebSocket</p>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-center">
          <p className="text-sm text-muted">No activity yet. Waiting for the bot to run…</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry, i) => (
            <div
              key={entry.ts + '-' + i}
              className="flex items-start gap-4 px-4 py-3 bg-surface-card border border-border rounded-xl hover:bg-surface-elevated transition-colors duration-100"
            >
              {/* Timestamp */}
              <span className="text-xs text-muted font-mono w-32 shrink-0 pt-0.5">{formatDate(entry.ts)}</span>

              {/* Content */}
              {entry.kind === 'decision' && (
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  {actionBadge(entry.data.action)}
                  <span className="font-medium text-sm">{entry.data.coin.replace('/USDC', '')}</span>
                  <span className="text-sm text-muted truncate flex-1">{entry.data.reason}</span>
                  <span className="text-xs text-muted shrink-0">{Math.round(entry.data.confidence * 100)}%</span>
                </div>
              )}

              {entry.kind === 'trade' && (
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  {statusBadge(entry.data.status)}
                  <span className="font-medium text-sm">{entry.data.coin.replace('/USDC', '')}</span>
                  {actionBadge(entry.data.side)}
                  <span className="text-sm text-muted">{fmt(entry.data.quantity, 4)}</span>
                  {entry.data.price ? (
                    <span className="text-sm text-muted">@ {fmtUSD(entry.data.price)}</span>
                  ) : null}
                </div>
              )}

              {entry.kind === 'approval' && (
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <Badge variant="warning">APPROVAL</Badge>
                  <span className="font-medium text-sm">{entry.data.coin.replace('/USDC', '')}</span>
                  {actionBadge(entry.data.side)}
                  <span className="text-sm text-muted truncate flex-1">{entry.data.reason}</span>
                </div>
              )}

              {entry.kind === 'snapshot' && (
                <div className="flex items-center gap-3 flex-1">
                  <Badge variant="accent">SNAPSHOT</Badge>
                  <span className="text-sm text-muted">Portfolio snapshot updated</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
