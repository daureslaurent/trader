import { Signal, MarketContext } from '../types.js'

/**
 * The entry band actually applied to an intent — the pullback / invalidate /
 * chase-cap / TTL window the price-watch loop fires against. Lives here (not in a
 * separate planner module) because the band is a core entry concept: it is set
 * either from the static `entry_*` settings, by the Entry Agent, or by a manual
 * edit. `source` records which, so the Entry Desk can badge the levels.
 */
export interface EntryBand {
  /** Buy target as % below the signal price (the dip to wait for). */
  pullbackPct: number
  /** Falling-knife cancel: abandon if price drops this % below the signal price. */
  invalidatePct: number
  /** Chase cap: abandon if price rises this % above the signal price. */
  chaseCapPct: number
  /** How long the intent stays live before expiring, in minutes. */
  ttlMinutes: number
  /** How the levels were chosen. */
  source: BandSource
  /** One-line rationale (present for an Entry Agent band). */
  reason?: string
}

/** How a band's levels were chosen: static settings, the Entry Agent, or a user edit. */
export type BandSource = 'static' | 'agent' | 'manual'

/**
 * A deferred BUY: the analyst has decided direction/size, but instead of firing
 * at the cron-tick price we wait for a *good* entry. The engine watches the live
 * price feed and fires (or cancels) per the pullback / invalidate / chase-cap /
 * TTL rules below.
 */
export interface EntryIntent {
  id: string
  coin: string
  /** The original BUY signal (quantity is recomputed at fire time from notionalUsdc). */
  signal: Signal
  /** Price at analysis time — the basis for the trigger levels. */
  signalPrice: number
  /** Fire when live price dips to/through this (the good entry). */
  targetPrice: number
  /** Cancel if live price gaps below this (falling knife — thesis broken). */
  invalidatePrice: number
  /** Cancel if live price runs above this (missed it — don't chase). */
  chaseCapPrice: number
  /** Fixed USDC to deploy; coin quantity is derived from the actual fill price. */
  notionalUsdc: number
  /** ATR at analysis time — passed through so SL/TP are computed at the fill price. */
  atr: number
  /** How the band levels were set: the static settings, the Entry Agent, or a user edit. */
  bandSource: BandSource
  /** The agent's one-line rationale for these levels (present only when bandSource === 'agent'). */
  planReason?: string
  createdAt: number
  expiresAt: number
  /** Every band assignment since registration (creation, each "Refresh LLM", each manual edit), oldest first. */
  bandHistory: BandSnapshot[]
}

/**
 * A point-in-time record of the band applied to an intent, plus the market data
 * the decision was made from. The Entry Desk uses the list of these on an intent
 * to show what the engine/LLM saw and how the band changed across re-plans.
 */
export interface BandSnapshot {
  at: number
  source: BandSource
  signalPrice: number
  targetPrice: number
  invalidatePrice: number
  chaseCapPrice: number
  ttlMinutes: number
  reason?: string
  /** Market context the agent saw when this band was set (absent for a manual edit). */
  market?: MarketContext
}

export type CancelReason = 'falling_knife' | 'ran_away' | 'expired' | 'manual' | 'agent'
export type FillTrigger = 'pullback' | 'expiry-market' | 'manual'

/**
 * A point-in-time record of something the engine did, for the activity feed.
 * Kept in a small in-memory ring buffer (session-scoped, lost on restart).
 */
export interface EntryEvent {
  id: string
  coin: string
  type: 'registered' | 'filled' | 'cancelled'
  /** FillTrigger for 'filled', CancelReason for 'cancelled'. */
  reason?: FillTrigger | CancelReason
  signalPrice: number
  targetPrice: number
  /** Observed price at fill/cancel time. */
  price?: number
  /** (signalPrice − fillPrice) / signalPrice × 100 — positive = bought below the signal price. */
  slippagePct?: number
  at: number
  /** The resolved intent's signal + band history at the time it filled/cancelled, for the Entry Desk detail view. */
  signal?: Signal
  bandHistory?: BandSnapshot[]
}
