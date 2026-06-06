import { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface StatProps {
  label: string
  value: string | number
  sub?: string
  icon?: ReactNode
  trend?: 'up' | 'down' | 'neutral'
  className?: string
}

export function Stat({ label, value, sub, icon, trend, className }: StatProps) {
  return (
    <div className={cn('bg-surface-card border border-border rounded-2xl p-5 neon-border', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted uppercase tracking-wider truncate">{label}</p>
          <p className="mt-2 text-2xl font-semibold text-foreground tabular-nums leading-none">{value}</p>
          {sub && (
            <p className={cn(
              'mt-1.5 text-xs font-medium',
              trend === 'up' && 'text-buy',
              trend === 'down' && 'text-sell',
              (!trend || trend === 'neutral') && 'text-muted',
            )}>
              {sub}
            </p>
          )}
        </div>
        {icon && (
          <div className="shrink-0 p-2.5 rounded-xl bg-accent/10 text-accent">
            {icon}
          </div>
        )}
      </div>
    </div>
  )
}
