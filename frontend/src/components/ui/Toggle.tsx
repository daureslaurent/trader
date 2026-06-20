import { cn } from '../../lib/utils'

// Animated pill switch. `danger` swaps the on-state accent for the sell color
// (used for destructive options like "Trust LLM SL/TP" or "Disable endpoint").
export function Toggle({ checked, onChange, danger, label }: {
  checked: boolean
  onChange: () => void
  danger?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        'group relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card',
        checked
          ? danger ? 'bg-sell' : 'bg-accent'
          : 'bg-surface-elevated border border-border',
      )}
    >
      <span
        className={cn(
          'pointer-events-none h-[18px] w-[18px] rounded-full shadow-sm transition-all duration-200',
          checked
            ? 'translate-x-[22px] bg-surface-base'
            : 'translate-x-[3px] bg-muted group-hover:bg-foreground/70',
        )}
      />
    </button>
  )
}
