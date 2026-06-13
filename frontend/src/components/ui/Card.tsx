import { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface CardProps {
  children: ReactNode
  className?: string
  onClick?: () => void
  noPad?: boolean
}

export function Card({ children, className, onClick, noPad }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'bg-surface-card border border-border rounded-2xl neon-border shadow-soft',
        !noPad && 'p-5',
        onClick && 'cursor-pointer transition-all duration-200 hover:bg-surface-elevated hover:border-accent/25 hover:-translate-y-0.5',
        className,
      )}
    >
      {children}
    </div>
  )
}

interface CardHeaderProps {
  title: string
  subtitle?: string
  action?: ReactNode
  className?: string
}

export function CardHeader({ title, subtitle, action, className }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between mb-4', className)}>
      <div>
        <h3 className="text-sm font-semibold text-foreground tracking-tight">{title}</h3>
        {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  )
}
