import { PositionReview } from '../types.js'

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
  ageHours: number
  horizon: 'short' | 'medium' | 'long'
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

export function fmtPrice(n: number): string {
  if (!isFinite(n) || n === 0) return '0'
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  if (n >= 0.01) return n.toFixed(6)
  return n.toPrecision(5)
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return 'N/A'
  return n.toFixed(2) + '%'
}

const HORIZON_BEHAVIOR: Record<'short' | 'medium' | 'long', string> = {
  short: `SHORT horizon (days to weeks):
  - Prioritise capital protection and quick profit-taking over patience.
  - CLOSE or REDUCE on the first sign of trend weakness; don't wait for a full reversal.
  - Trail stops aggressively — move SL up to break-even or just below SMA7 early.
  - If in profit ≥ TP target, REDUCE to lock in gains rather than holding for more.
  - Accept less upside to avoid giving back gains.`,

  medium: `MEDIUM horizon (weeks to months):
  - Standard risk management — balance protection against normal market noise.
  - Hold through minor pullbacks if the trend and RSI are broadly intact.
  - Trail stop conservatively (below SMA25 or ATR×2 from price) once meaningfully in profit.
  - CLOSE only on confirmed trend reversal or if SL is imminent (<2% away).`,

  long: `LONG horizon (months to years):
  - Patient positioning — short-term noise should not trigger action.
  - Only CLOSE on major macro trend reversals; a 5–10% dip in an uptrend is normal.
  - Widen stops only when structurally justified (e.g. new higher low on weekly chart).
  - Prefer HOLD or mild ADJUST over REDUCE; preserving position size matters more.
  - Act on RSI extremes (>80 or <30) combined with clear trend change, not either alone.`,
}

export function buildMonitorPrompt(
  position: PositionContext,
  history: PositionReview[],
  horizonConfigs: HorizonConfigs,
): { system: string; user: string } {
  const cfg = horizonConfigs[position.horizon]
  const horizonBehavior = HORIZON_BEHAVIOR[position.horizon]

  const system = `You are a professional crypto trading risk manager. Review one open long position and recommend exactly one action: HOLD, ADJUST, REDUCE, or CLOSE.

── Actions ──────────────────────────────────────────────────────────────────
CLOSE      Exit entirely. Use when SL is imminent (<2% away), trend reversed to downtrend
           with negative momentum, or deeply underwater with no recovery signals.
REDUCE     Partial exit. Set reduce_to_pct (integer: % of current size to keep, e.g. 50 = keep half).
           Use to lock in gains near TP, or to de-risk a weakening position.
ADJUST     Keep the position but update stop-loss and/or take-profit.
           Use to trail the stop UP as price rises, extend TP in a strong trend,
           or tighten risk when momentum weakens.
           Express levels as PERCENTAGES relative to current price (not absolute USD):
             new_stop_loss_pct  — negative = below current price (e.g. -3.5 means SL 3.5% below)
             new_take_profit_pct — positive = above current price (e.g. +8.0 means TP 8% above)
HOLD       No change. Trend intact, SL buffer healthy, no compelling reason to act.

── Horizon: ${position.horizon.toUpperCase()} ─────────────────────────────────────────────────────
${horizonBehavior}

── Configured SL/TP targets for ${position.horizon.toUpperCase()} ──────────────────────────────────
  Stop-loss target:   -${cfg.slPct.toFixed(1)}% from current price
  Take-profit target: +${cfg.tpPct.toFixed(1)}% from current price
  These are the owner's risk preferences.
  - If the current SL is not yet set, propose new_stop_loss_pct = -${cfg.slPct.toFixed(1)} (or tighter if price has moved up).
  - If the current TP is not yet set, propose new_take_profit_pct = +${cfg.tpPct.toFixed(1)} (or higher if price has moved up).
  - When trailing the stop, aim to stay near -${cfg.slPct.toFixed(1)}% from the recent high, not from entry.

── Hard risk rules (engine-enforced) ────────────────────────────────────────
- Stop-loss may only be TIGHTENED (raised toward price). Loosening is always rejected.
- new_stop_loss_pct must be negative (below current price); new_take_profit_pct must be positive.
- Base levels on ATR(14), SMA7, SMA25, and entry price. Skip trivial tweaks (<0.5% moves).

── Output ───────────────────────────────────────────────────────────────────
Return a single JSON object — no markdown, no extra keys:
{
  "action": "ADJUST",
  "confidence": 0.8,
  "reasoning": "Up 6.2%, uptrend intact, RSI 61. Trailing stop to 3% below current price.",
  "reduce_to_pct": null,
  "new_stop_loss_pct": -3.0,
  "new_take_profit_pct": null
}
Use null for new_stop_loss_pct / new_take_profit_pct when not changing them.`

  const p = position
  const pnlSign = p.pnlPct >= 0 ? '+' : ''
  const ch24Sign = p.change24h >= 0 ? '+' : ''
  const p7Sign = p.perf7d >= 0 ? '+' : ''
  const slPct = p.stopLoss != null && p.entryPrice > 0
    ? ((p.stopLoss - p.entryPrice) / p.entryPrice * 100)
    : null
  const tpPct = p.takeProfit != null && p.entryPrice > 0
    ? ((p.takeProfit - p.entryPrice) / p.entryPrice * 100)
    : null
  const sl = p.stopLoss != null
    ? `$${fmtPrice(p.stopLoss)} (${slPct!.toFixed(2)}%)`
    : `not yet set (target: -${cfg.slPct.toFixed(1)}%)`
  const tp = p.takeProfit != null
    ? `$${fmtPrice(p.takeProfit)} (+${tpPct!.toFixed(2)}%)`
    : `not yet set (target: +${cfg.tpPct.toFixed(1)}%)`

  const positionText = `Coin:     ${p.coin}
Horizon:  ${p.horizon.toUpperCase()} (SL target: -${cfg.slPct.toFixed(1)}%, TP target: +${cfg.tpPct.toFixed(1)}%)
Qty:      ${p.quantity} | Entry: $${fmtPrice(p.entryPrice)} | Current: $${fmtPrice(p.currentPrice)}
P&L:      ${pnlSign}$${p.pnlUsd.toFixed(2)} (${pnlSign}${p.pnlPct.toFixed(2)}%) | Age: ${p.ageHours.toFixed(1)}h
Stop:     ${sl}
TP:       ${tp}
RSI(14):  ${p.rsi14.toFixed(1)} | Trend: ${p.trend} | Volatility: ${p.volatility}
24h:      ${ch24Sign}${p.change24h.toFixed(2)}% | 7d: ${p7Sign}${p.perf7d.toFixed(2)}%
ATR(14):  $${fmtPrice(p.atr14)} | SMA7: $${fmtPrice(p.sma7)} | SMA25: $${fmtPrice(p.sma25)}`

  let historyText = ''
  if (history.length > 0) {
    const rows = history.map(h => {
      const md = (() => { try { return JSON.parse(h.market_data) as Record<string, unknown> } catch { return {} } })()
      const when = h.created_at.slice(0, 16)
      const priceStr = typeof md.currentPrice === 'number' ? ` @ $${fmtPrice(md.currentPrice)}` : ''
      const snippet = h.reasoning.length > 120 ? h.reasoning.slice(0, 117) + '...' : h.reasoning
      return `  [${when}] ${h.action} (conf ${h.confidence.toFixed(2)})${priceStr}: ${snippet}`
    }).join('\n')
    historyText = `\n\nRecent reviews for ${p.coin} (newest first):\n${rows}`
  }

  const user = `Review this open position and recommend an action:\n\n${positionText}${historyText}\n\nRespond with a single JSON object.`

  return { system, user }
}
