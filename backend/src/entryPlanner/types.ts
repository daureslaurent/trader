/**
 * Per-coin entry-band parameters chosen by the Entry Planner LLM for a single
 * deferred BUY. Percentages mirror the static `entry_*` settings, but are decided
 * with live market context + the analyst's thesis so the entry window fits the
 * setup rather than being one-size-fits-all.
 */
export interface EntryPlan {
  /** Buy target as % below the signal price (the dip to wait for). */
  pullbackPct: number
  /** Falling-knife cancel: abandon if price drops this % below the signal price. */
  invalidatePct: number
  /** Chase cap: abandon if price rises this % above the signal price. */
  chaseCapPct: number
  /** How long the intent stays live before expiring, in minutes. */
  ttlMinutes: number
  /** One-line rationale for these levels (shown on the Entry Desk). */
  reason: string
}

/**
 * The resolved entry band actually applied to an intent — either the LLM plan or
 * the static `entry_*` settings fallback. `source` records which, so the Entry
 * Desk can show whether levels were LLM-decided.
 */
export interface EntryBand {
  pullbackPct: number
  invalidatePct: number
  chaseCapPct: number
  ttlMinutes: number
  source: 'llm' | 'static'
  /** Present only when `source === 'llm'`. */
  reason?: string
}
