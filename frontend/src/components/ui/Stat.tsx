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
    <div className={cn(
      'group relative overflow-hidden bg-surface-card border border-border rounded-2xl p-5 neon-border shadow-soft',
      'transition-colors duration-200 hover:border-accent/25',
      className,
    )}>
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-muted uppercase tracking-wider truncate">{label}</p>
          <p className="mt-2.5 text-[26px] font-bold text-foreground tabular-nums leading-none tracking-tight">{value}</p>
          {sub && (
            <p className={cn(
              'mt-2 text-xs font-medium',
              trend === 'up' && 'text-buy',
              trend === 'down' && 'text-sell',
              (!trend || trend === 'neutral') && 'text-muted',
            )}>
              {sub}
            </p>
          )}
        </div>
        {icon && (
          <div className="shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-accent/15 to-accent2/10 ring-1 ring-accent/10 text-accent flex items-center justify-center">
            {icon}
          </div>
        )}
      </div>
    </div>
  )
}
