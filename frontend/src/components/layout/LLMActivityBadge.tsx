import { useLLMActivity } from '../../hooks/useLLMActivity'
import { cn } from '../../lib/utils'

const MODULE_LABELS: Record<string, string> = {
  extractor: 'Extractor',
  analyst: 'Analyst',
  monitor: 'Monitor',
  discoverer: 'Discoverer',
}

function label(module: string) {
  return MODULE_LABELS[module] ?? module.charAt(0).toUpperCase() + module.slice(1)
}

/**
 * Header badge reflecting whether any LLM call is in flight. Idle is a quiet
 * muted chip; active shows an animated accent chip with the in-flight count and
 * a tooltip breaking down which modules/coins are running.
 */
export function LLMActivityBadge() {
  const active = useLLMActivity()
  const count = active.length
  const busy = count > 0
  const queued = active.filter(c => c.status === 'queued').length
  const running = count - queued

  const tooltip = busy
    ? active
        .map(c => {
          const name = c.coin ? `${label(c.module)} · ${c.coin.replace('/USDC', '')}` : label(c.module)
          return c.status === 'queued' ? `${name} (queued)` : name
        })
        .join('\n')
    : 'No LLM calls running'

  return (
    <span
      title={tooltip}
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
        busy
          ? 'text-accent bg-accent/10 border-accent/20'
          : 'text-muted bg-surface-elevated border-border',
      )}
    >
      {busy ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
      )}
      {busy ? (running === 0 ? 'Queued' : 'Thinking') : 'LLM Idle'}
      {count > 1 && (
        <span className="ml-0.5 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full bg-accent/20 text-accent text-[10px] leading-none tabular-nums">
          {queued > 0 && running > 0 ? `${running}+${queued}` : count}
        </span>
      )}
    </span>
  )
}
