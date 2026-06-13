import { ReactNode } from 'react'
import { cn } from '../../lib/utils'

type Variant = 'buy' | 'sell' | 'hold' | 'pending' | 'executed' | 'failed' | 'neutral' | 'accent' | 'warning'

const VARIANTS: Record<Variant, string> = {
  buy:      'bg-buy/10 text-buy border-buy/20',
  sell:     'bg-sell/10 text-sell border-sell/20',
  hold:     'bg-warn/10 text-warn border-warn/20',
  warning:  'bg-warn/10 text-warn border-warn/20',
  pending:  'bg-warn/10 text-warn border-warn/20',
  executed: 'bg-buy/10 text-buy border-buy/20',
  failed:   'bg-sell/10 text-sell border-sell/20',
  neutral:  'bg-surface-elevated text-muted border-border',
  accent:   'bg-accent/10 text-accent border-accent/20',
}

interface BadgeProps {
  variant?: Variant
  children: ReactNode
  className?: string
  dot?: boolean
}

export function Badge({ variant = 'neutral', children, className, dot }: BadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border',
      VARIANTS[variant],
      className,
    )}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  )
}

export function actionBadge(action: string) {
  const v: Variant = action === 'BUY' ? 'buy' : action === 'SELL' ? 'sell' : 'hold'
  return <Badge variant={v}>{action}</Badge>
}

export function statusBadge(status: string) {
  const map: Record<string, Variant> = {
    EXECUTED: 'executed', PENDING: 'pending', FAILED: 'failed',
    OPEN: 'accent', CLOSED: 'neutral', SL_HIT: 'sell', TP_HIT: 'executed',
  }
  return <Badge variant={map[status] || 'neutral'}>{status.replace('_', ' ')}</Badge>
}
