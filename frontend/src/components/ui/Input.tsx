import { InputHTMLAttributes, forwardRef } from 'react'
import { cn } from '../../lib/utils'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className, ...rest }, ref) => (
    <div className="flex flex-col gap-1.5">
      {label && <label className="text-xs font-medium text-muted">{label}</label>}
      <input
        ref={ref}
        {...rest}
        className={cn(
          'w-full px-3 py-2 text-sm bg-surface-elevated border border-border rounded-xl',
          'text-foreground placeholder:text-muted',
          'focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50',
          'transition-colors duration-150',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          error && 'border-sell/50 focus:ring-sell/20',
          className,
        )}
      />
      {error && <p className="text-xs text-sell">{error}</p>}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
    </div>
  )
)
Input.displayName = 'Input'

interface SelectProps extends InputHTMLAttributes<HTMLSelectElement> {
  label?: string
  children: React.ReactNode
}

export function Select({ label, className, children, ...rest }: SelectProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <label className="text-xs font-medium text-muted">{label}</label>}
      <select
        {...rest}
        className={cn(
          'w-full px-3 py-2 text-sm bg-surface-elevated border border-border rounded-xl',
          'text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50',
          'transition-colors duration-150',
          className,
        )}
      >
        {children}
      </select>
    </div>
  )
}
