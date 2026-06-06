import { ReactNode, ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success'
type Size = 'xs' | 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary:   'bg-accent text-surface-base font-semibold hover:brightness-110 active:brightness-90',
  secondary: 'bg-surface-elevated border border-border text-foreground hover:bg-surface-hover',
  danger:    'bg-sell/10 border border-sell/20 text-sell hover:bg-sell/20',
  ghost:     'text-muted hover:text-foreground hover:bg-surface-elevated',
  success:   'bg-buy/10 border border-buy/20 text-buy hover:bg-buy/20',
}

const SIZES: Record<Size, string> = {
  xs: 'px-2.5 py-1 text-xs rounded-lg',
  sm: 'px-3 py-1.5 text-xs rounded-lg',
  md: 'px-4 py-2 text-sm rounded-xl',
  lg: 'px-5 py-2.5 text-sm rounded-xl',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children: ReactNode
  loading?: boolean
}

export function Button({ variant = 'secondary', size = 'md', children, loading, className, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 transition-all duration-150 cursor-pointer',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading && (
        <svg className="animate-spin h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  )
}
