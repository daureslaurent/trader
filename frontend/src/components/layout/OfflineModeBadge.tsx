import { useOfflineMode } from '../../hooks/useOfflineMode'
import { cn } from '../../lib/utils'

/**
 * Header badge showing the bot's effective decision mode. Green "LLM mode" when an endpoint is
 * reachable and the bot is using the LLM engines; amber "Offline mode" when running deterministic,
 * rule-based logic (manual override, or auto-fallback because every LLM endpoint is down). Hover
 * reveals the reason and what offline mode means.
 */
export function OfflineModeBadge() {
  const { active, reason } = useOfflineMode()

  const label = active ? 'Offline mode' : 'LLM mode'
  const detail = active
    ? reason === 'forced'
      ? 'Manually forced. Deterministic, rule-based trading is active — no LLM calls are made.'
      : 'No LLM endpoint is reachable, so the bot automatically switched to deterministic, rule-based trading. It returns to LLM mode once an endpoint recovers.'
    : 'LLM engines are driving entries, monitoring and discovery. Offline mode engages automatically if every endpoint goes down.'

  return (
    <div className="group relative">
      <button
        type="button"
        aria-label="Decision mode"
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
          active ? 'text-warn bg-warn/10 border-warn/20' : 'text-buy bg-buy/10 border-buy/20',
        )}
      >
        <span className="relative flex h-1.5 w-1.5">
          {active && (
            <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 animate-ping" />
          )}
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
        {label}
      </button>

      {/* Hover / focus detail card */}
      <div
        className={cn(
          'absolute right-0 top-full z-30 mt-2 w-72 origin-top-right',
          'invisible translate-y-1 opacity-0 transition-all duration-150',
          'group-hover:visible group-hover:translate-y-0 group-hover:opacity-100',
          'group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100',
        )}
      >
        <div className="overflow-hidden rounded-2xl border border-border bg-surface-card shadow-xl">
          <div className="border-b border-border px-3 py-2">
            <span className="text-xs font-semibold text-foreground">{label}</span>
          </div>
          <p className="px-3 py-2.5 text-[11px] leading-relaxed text-muted">{detail}</p>
        </div>
      </div>
    </div>
  )
}
