import { PositionReview } from '../types.js'
import { Candle, fmtPrice, renderCandleTable } from '../market/index.js'
import { minStopGapPct } from '../portfolio/risk.js'

export interface PositionContext {
  positionId: number | null
  coin: string
  quantity: number
  entryPrice: number
  currentPrice: number
  pnlUsd: number
  pnlPct: number
  stopLoss: number | null
  takeProfit: number | null
  distanceToSlPct: number | null
  distanceToTpPct: number | null
  entryDate: string
  ageHours: number
  horizon: 'short' | 'medium' | 'long' | 'disabled' | 'llm'
  rsi14: number
  trend: 'uptrend' | 'downtrend' | 'ranging'
  volatility: 'high' | 'normal' | 'low'
  atr14: number
  sma7: number
  sma25: number
  change24h: number
  perf7d: number
}

export interface HorizonConfig {
  slPct: number
  tpPct: number
}

export type HorizonConfigs = Record<'short' | 'medium' | 'long', HorizonConfig>

export interface MonitorNotes {
  notes: string
  updated_at: string
}

export function fmtOffsetLabel(offsetHours: number): string {
  if (offsetHours === 0) return 'UTC'
  const sign = offsetHours > 0 ? '+' : '-'
  const abs = Math.abs(offsetHours)
  const h = Math.floor(abs)
  const m = Math.round((abs - h) * 60)
  return m > 0 ? `UTC${sign}${h}:${m.toString().padStart(2, '0')}` : `UTC${sign}${h}`
}

// Per-horizon behaviour guidance.
function horizonBehavior(horizon: 'short' | 'medium' | 'long'): string {
  switch (horizon) {
    case 'short':
      return `SHORT horizon (days to weeks):
  - Prioritise capital protection and quick profit-taking over patience.
  - CLOSE on the first sign of trend weakness; don't wait for a full reversal.
  - Trail stops aggressively — move SL up to break-even or just below SMA7 early.
  - If in profit ≥ TP target, tighten the stop hard (ADJUST) to lock in gains rather than holding for more.
  - Accept less upside to avoid giving back gains.`

    case 'medium':
      return `MEDIUM horizon (weeks to months):
  - Standard risk management — balance protection against normal market noise.
  - Hold through minor pullbacks if the trend and RSI are broadly intact.
  - Trail stop conservatively (below SMA25 or ATR×2 from price) once meaningfully in profit.
  - CLOSE only on confirmed trend reversal — otherwise let the stop-loss handle downside exits.`

    case 'long':
      return `LONG horizon (months to years):
  - Patient positioning — short-term noise should not trigger action.
  - Only CLOSE on major macro trend reversals; a 5–10% dip in an uptrend is normal.
  - Widen stops only when structurally justified (e.g. new higher low on weekly chart).
  - Prefer HOLD or mild ADJUST; preserving position size matters more.
  - Act on RSI extremes (>80 or <30) combined with clear trend change, not either alone.`
  }
}

export function buildMonitorPrompt(
  position: PositionContext,
  history: PositionReview[],
  horizonConfigs: HorizonConfigs,
  useHorizon = true,
  utcOffsetHours = 0,
  candles: Candle[] = [],
  candleTf = '1h',
  reviewIntervalMin: number | null = null,
  notes: MonitorNotes | null = null,
  breakevenPct = 3,
): { system: string; synthSystem: string; user: string } {
  const effectiveHorizon: 'short' | 'medium' | 'long' =
    (position.horizon === 'disabled' || position.horizon === 'llm') ? 'medium' : position.horizon
  const cfg = horizonConfigs[effectiveHorizon]
  const behavior = horizonBehavior(effectiveHorizon)

  const horizonSection = useHorizon ? `
── Horizon: ${position.horizon.toUpperCase()} ─────────────────────────────────────────────────────
${behavior}

── Configured SL/TP targets for ${position.horizon.toUpperCase()} ──────────────────────────────────
  Stop-loss target:   -${cfg.slPct.toFixed(1)}% from current price
  Take-profit target: +${cfg.tpPct.toFixed(1)}% from current price
  These are the owner's risk preferences.
  - If the current SL is not yet set, propose new_stop_loss_pct = -${cfg.slPct.toFixed(1)} (or tighter if price has moved up).
  - If the current TP is not yet set, propose new_take_profit_pct = +${cfg.tpPct.toFixed(1)} (or higher if price has moved up).
  - When trailing the stop, aim to stay near -${cfg.slPct.toFixed(1)}% from the recent high, not from entry.
` : ''

  const breakEvenTrigger = useHorizon ? (cfg.tpPct / 2).toFixed(1) : breakevenPct.toFixed(1)
  const minGap = minStopGapPct(useHorizon ? cfg.slPct : null).toFixed(1)

  const profitProtection = `── Profit protection (apply in order) ───────────────────────────────────────
- Once P&L ≥ +${breakEvenTrigger}%, the stop must sit at break-even or better (SL ≥ entry price).
  If it doesn't, ADJUST now — never let a meaningful winner turn into a loser.
- BELOW +${breakEvenTrigger}% P&L, do NOT move the stop to break-even "to protect" a tiny gain —
  a stop within noise distance of the price guarantees a fee-paying scratch exit.
  The engine rejects break-even stops before +${breakEvenTrigger}% and any stop closer than
  ${minGap}% to the current price. Leave the original stop alone and let the trade breathe.
- While in profit, the stop only ratchets UP. Never widen the SL or lower the TP of a winning position.
- Lock gains against the price structure: trail under the most recent higher low or SMA7,
  not a fixed % below a spike high.`

  const hardRules = useHorizon
    ? `${profitProtection}

── Hard risk rules (engine-enforced) ────────────────────────────────────────
- While the position is in profit, the engine REJECTS any SL loosening or TP lowering.
- Below break-even you MAY widen the stop back toward the target distance to give the
  trade room; in profit the stop only ratchets up.
- Stop-loss loosening is capped at -${cfg.slPct.toFixed(1)}% from current price (the horizon floor).
  Only loosen when volatility has expanded or the original stop was structurally wrong.
  Prefer tightening (trailing) when the trend is intact.
- new_stop_loss_pct must be negative (below current price); new_take_profit_pct must be positive.
- Base levels on ATR(14), SMA7, SMA25, and entry price. Skip trivial tweaks (<0.5% moves).`
    : `${profitProtection}

── Hard risk rules (engine-enforced) ────────────────────────────────────────
- While the position is in profit, the engine REJECTS any SL loosening or TP lowering.
- Below break-even you MAY widen the stop to give the trade room; in profit the stop
  only ratchets up.
- new_stop_loss_pct must be negative (below current price); new_take_profit_pct must be positive.
- Base levels on ATR(14), SMA7, SMA25, and entry price. Skip trivial tweaks (<0.5% moves).`

  const adjustSeedNote = useHorizon
    ? 'untouched side as-is (or seeds it from the horizon target if none exists),'
    : 'untouched side as-is (or seeds it from ATR/SMAs if none exists),'

  const cadenceText = reviewIntervalMin != null
    ? reviewIntervalMin < 60
      ? `every ${reviewIntervalMin} minutes`
      : `every ${Math.round(reviewIntervalMin / 60)} hour(s)`
    : 'periodically'

  // The system prompt is one shared `body` (actions, rules, schema — identical for
  // every model) preceded by a role-specific opener. Voters (A/B) get the reviewer
  // opener; the synthesizer (C) gets an arbiter opener that frames its job as deciding
  // FROM the two voter verdicts rather than reviewing from scratch. Same body so C is
  // bound by the exact same rules and answers in the exact same schema.
  const reviewerOpener = `You are a professional crypto trading risk manager. Review one open long position and recommend exactly one action: HOLD, ADJUST, or CLOSE.`

  const synthesizerOpener = `You are the senior risk manager and FINAL ARBITER for one open long position. Two independent analysts have each already reviewed this exact position and proposed an action; their verdicts are appended after the position data below. Your job is to SYNTHESIZE, not to review from scratch: weigh both opinions against the market data and issue the single authoritative decision — exactly one action: HOLD, ADJUST, or CLOSE. Reason explicitly from the two analysts — state where they agree, adjudicate where they conflict, and decide. You may adopt one analyst's call, blend the two, or override both when the evidence demands it, but never merely average their numbers. The same rules below that bounded their reviews bind your verdict identically.`

  const body = `── Actions ──────────────────────────────────────────────────────────────────
CLOSE      Exit the whole position now (market sell). Use on confirmed trend reversal
           with negative momentum, or when deeply underwater with no recovery signals.
           Do NOT close merely because price is approaching the stop-loss — the
           exchange-side stop exists exactly for that; closing early converts every
           ordinary dip into a realized loss.
ADJUST     Keep the position but update stop-loss and/or take-profit.
           Use to trail the stop UP as price rises, extend TP in a strong trend,
           or tighten risk when momentum weakens.
           Express BOTH levels as PERCENTAGES relative to the CURRENT price (never
           absolute USD, never relative to entry):
             new_stop_loss_pct   — negative = below current price (e.g. -3.5 → SL 3.5% below)
             new_take_profit_pct — positive = above current price (e.g. +8.0 → TP 8% above)
           null means "leave this side unchanged" — the engine keeps the
           ${adjustSeedNote}
           so a complete stop+target pair is always maintained. NEVER re-state the
           current level as a "new" value: only propose a level that differs from the
           shown one by at least 0.5%; otherwise use HOLD or set that side to null.
HOLD       No change. Trend intact, SL buffer healthy, no compelling reason to act.

── Decision consistency ──────────────────────────────────────────────────────
This review runs automatically ${cadenceText}. The default outcome of any single
review is HOLD — act only when something structural changed since the last review.
The past 3 decisions are provided for context. Use them to:
- Avoid flip-flopping: if you just HOLDed and nothing structural has changed, HOLD again.
- Recognize a trend: repeated HOLD + rising price → trail the stop UP (ADJUST), don't keep holding a stale SL.
- Not repeat the same ADJUST twice in a row if price barely moved since the last one.

── Persistent notes (your memory) ───────────────────────────────────────────
You keep ONE persistent note for this position. Unlike the decision history
(only the last 3 reviews), the note survives every review until the position
closes — it is your long-term memory. Use it for durable facts you will need
in future reviews: the position thesis, key support/resistance levels, the
swing high you are trailing against, invalidation conditions, what to watch.
- The "notes" output field REPLACES the stored note entirely. Always rewrite
  the complete note — never a diff or an addition.
- Return "notes": null to keep the existing note unchanged.
- Keep it under 500 characters. Terse facts and levels, not prose.
- Refresh it when something durable changes (new swing high, level broken,
  thesis weakening). A stale note is worse than none.
${horizonSection}
${hardRules}

── Output ───────────────────────────────────────────────────────────────────
Return a single JSON object — no markdown, no extra keys:
{
  "action": "ADJUST",
  "confidence": 0.8,
  "reasoning": "Up 6.2%, uptrend intact, RSI 61. Trailing stop to 3% below current price.",
  "new_stop_loss_pct": -3.0,
  "new_take_profit_pct": null,
  "notes": "Thesis: breakout above $3.20 held. Trailing vs swing high $3.42. Invalidation: 1h close below $3.05. Watch RSI cooling from 70."
}
Use null for new_stop_loss_pct / new_take_profit_pct when not changing them,
and null for notes to keep the stored note as-is.`

  const system = `${reviewerOpener}\n\n${body}`
  const synthSystem = `${synthesizerOpener}\n\n${body}`

  const p = position
  const pnlSign = p.pnlPct >= 0 ? '+' : ''
  const ch24Sign = p.change24h >= 0 ? '+' : ''
  const p7Sign = p.perf7d >= 0 ? '+' : ''

  // Show SL/TP in the SAME frame the model must answer in: a signed % relative to
  // the CURRENT price (negative = below, positive = above). This is exactly the
  // new_stop_loss_pct / new_take_profit_pct convention, so there is one coordinate
  // frame end-to-end — no entry-relative vs current-relative ambiguity.
  const sgn = (n: number) => (n >= 0 ? '+' : '')
  const slFromCurrent = p.stopLoss != null && p.currentPrice > 0
    ? ((p.stopLoss - p.currentPrice) / p.currentPrice) * 100
    : null
  const tpFromCurrent = p.takeProfit != null && p.currentPrice > 0
    ? ((p.takeProfit - p.currentPrice) / p.currentPrice) * 100
    : null
  const sl = slFromCurrent != null
    ? `$${fmtPrice(p.stopLoss!)} (${sgn(slFromCurrent)}${slFromCurrent.toFixed(2)}% from price)${slFromCurrent >= 0 ? ' ⚠ at/above price — SL imminent' : ''}`
    : useHorizon
      ? `not set — seed new_stop_loss_pct = -${cfg.slPct.toFixed(1)}`
      : 'not set'
  const tp = tpFromCurrent != null
    ? `$${fmtPrice(p.takeProfit!)} (${sgn(tpFromCurrent)}${tpFromCurrent.toFixed(2)}% from price)`
    : useHorizon
      ? `not set — seed new_take_profit_pct = +${cfg.tpPct.toFixed(1)}`
      : 'not set'

  const horizonLine = (useHorizon && position.horizon !== 'llm')
    ? `${p.horizon.toUpperCase()} (SL target: -${cfg.slPct.toFixed(1)}%, TP target: +${cfg.tpPct.toFixed(1)}% from current price)`
    : p.horizon.toUpperCase()

  const positionText = `Coin:     ${p.coin}
Horizon:  ${horizonLine}
Opened:   ${p.entryDate} (${p.ageHours.toFixed(1)}h ago)
Qty:      ${p.quantity} | Entry: $${fmtPrice(p.entryPrice)} | Current: $${fmtPrice(p.currentPrice)}
P&L:      ${pnlSign}$${p.pnlUsd.toFixed(2)} (${pnlSign}${p.pnlPct.toFixed(2)}%)
Stop:     ${sl}
TP:       ${tp}
RSI(14):  ${p.rsi14.toFixed(1)} | Trend: ${p.trend} | Volatility: ${p.volatility}
24h:      ${ch24Sign}${p.change24h.toFixed(2)}% | 7d: ${p7Sign}${p.perf7d.toFixed(2)}%
ATR(14):  $${fmtPrice(p.atr14)} | SMA7: $${fmtPrice(p.sma7)} | SMA25: $${fmtPrice(p.sma25)}`

  // ── Candle history section ────────────────────────────────────────────────
  const candleTable = renderCandleTable(candles, candleTf)
  const candleHistoryText = candleTable ? `\n\n${candleTable}` : ''

  // ── Persistent notes (LLM's own memory from previous reviews) ────────────
  let notesText = ''
  if (notes) {
    const ageMs = Date.now() - new Date(notes.updated_at.replace(' ', 'T') + 'Z').getTime()
    const ageH = ageMs / 3_600_000
    const ago = ageH < 1
      ? `${Math.round(ageMs / 60_000)}m ago`
      : ageH < 48
        ? `${Math.round(ageH)}h ago`
        : `${Math.round(ageH / 24)}d ago`
    notesText = `\n\n── Your persistent notes (written by you, ${ago}) ───────────────────────────
${notes.notes}`
  } else {
    notesText = `\n\n── Your persistent notes ─────────────────────────────────────────────────────
(none yet — write the initial note: thesis, key levels, invalidation conditions)`
  }

  // ── Previous monitor decisions (up to 3, relative age) ───────────────────
  let prevDecisionText = ''
  if (history.length > 0) {
    const nowMs = Date.now()
    const rows = history.map((rev, i) => {
      const ageMs = nowMs - new Date(rev.created_at.replace(' ', 'T') + 'Z').getTime()
      const ageH = ageMs / 3_600_000
      const ago = ageH < 1
        ? `${Math.round(ageMs / 60_000)}m ago`
        : ageH < 48
          ? `${Math.round(ageH)}h ago`
          : `${Math.round(ageH / 24)}d ago`
      const slDelta = rev.new_stop_loss != null && rev.old_stop_loss != null
        ? ` · SL ${rev.old_stop_loss > rev.new_stop_loss ? '▼' : '▲'} $${fmtPrice(rev.new_stop_loss)}`
        : rev.new_stop_loss != null ? ` · SL set $${fmtPrice(rev.new_stop_loss)}` : ''
      const tpDelta = rev.new_take_profit != null && rev.old_take_profit != null
        ? ` · TP ${rev.old_take_profit > rev.new_take_profit ? '▼' : '▲'} $${fmtPrice(rev.new_take_profit)}`
        : rev.new_take_profit != null ? ` · TP set $${fmtPrice(rev.new_take_profit)}` : ''
      const label = i === 0 ? 'Latest' : `${i + 1}. earlier`
      return `${label} (${ago}): ${rev.action} conf=${rev.confidence.toFixed(2)}${slDelta}${tpDelta}\n  "${rev.reasoning}"`
    })
    prevDecisionText = `\n\n── Past monitor decisions (newest first) ────────────────────────────────────
${rows.join('\n')}`
  }

  const user = `Review this open position and recommend an action:\n\n${positionText}${candleHistoryText}${notesText}${prevDecisionText}\n\nRespond with a single JSON object.`

  return { system, synthSystem, user }
}

/** One analyst opinion fed to the synthesizer (model C) in A+B+C mode. */
export interface EnsembleOpinion {
  label: string
  model: string
  action: string
  confidence: number
  reasoning: string
  new_stop_loss_pct?: number | null
  new_take_profit_pct?: number | null
}

// Builds model C's user prompt in 'abc' mode: the same position review the A/B models
// saw, with their two verdicts appended as the material to synthesize. The arbiter
// ROLE (weigh both, may adopt/blend/override, never average, identical schema) lives in
// C's dedicated system prompt (synthSystem) — this only supplies the two verdicts as
// data plus a short cue to decide.
export function buildSynthesizerUser(baseUser: string, opinions: EnsembleOpinion[]): string {
  const rendered = opinions.map((o) => {
    const extras: string[] = []
    if (typeof o.new_stop_loss_pct === 'number') extras.push(`SL ${o.new_stop_loss_pct > 0 ? '+' : ''}${o.new_stop_loss_pct}%`)
    if (typeof o.new_take_profit_pct === 'number') extras.push(`TP ${o.new_take_profit_pct > 0 ? '+' : ''}${o.new_take_profit_pct}%`)
    const extraText = extras.length ? ` · ${extras.join(' · ')}` : ''
    return `Analyst ${o.label} (${o.model}): ${o.action} conf=${o.confidence.toFixed(2)}${extraText}\n  "${o.reasoning}"`
  }).join('\n\n')

  return `${baseUser}

── The two analysts' verdicts to synthesize ─────────────────────────────────
${rendered}

Now adjudicate the two verdicts against the position data above and issue your
final arbiter decision as a single JSON object in the required schema.`
}
