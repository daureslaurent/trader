import { Signal } from '../types.js'

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
  /** Whether the band levels were chosen by the Entry Planner LLM or the static settings. */
  bandSource: 'llm' | 'static'
  /** The LLM's one-line rationale for these levels (present only when bandSource === 'llm'). */
  planReason?: string
  createdAt: number
  expiresAt: number
}

export type CancelReason = 'falling_knife' | 'ran_away' | 'expired' | 'manual'
export type FillTrigger = 'pullback' | 'expiry-market'

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
}
