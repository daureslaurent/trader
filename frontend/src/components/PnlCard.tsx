import { cn, fmtUSD } from '../lib/utils'
import { Card } from './ui/Card'

interface Props {
  finalUsd: number
  finalPct: number | null
  liveUsd: number
  livePct: number | null
}

function PnlValue({ usd, pct }: { usd: number; pct: number | null }) {
  const pos = usd >= 0
  const sign = pos ? '+' : ''
  const cls = pos ? 'text-buy' : 'text-sell'
  return (
    <p className={cn('text-2xl font-bold tabular-nums leading-none', cls)}>
      {sign}{fmtUSD(usd)}
      {pct != null && (
        <span className="text-sm font-medium ml-2 opacity-80">
          ({sign}{pct.toFixed(2)}%)
        </span>
      )}
    </p>
  )
}

export function PnlCard({ finalUsd, finalPct, liveUsd, livePct }: Props) {
  return (
    <Card>
      <div className="flex items-stretch gap-6">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-muted uppercase tracking-wider mb-2">Realized P&L</p>
          <PnlValue usd={finalUsd} pct={finalPct} />
          <p className="text-xs text-muted mt-1.5">from closed positions</p>
        </div>
        <div className="w-px bg-border shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-muted uppercase tracking-wider mb-2">Open P&L</p>
          <PnlValue usd={liveUsd} pct={livePct} />
          <p className="text-xs text-muted mt-1.5">live unrealized gain</p>
        </div>
      </div>
    </Card>
  )
}
