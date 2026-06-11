import { PositionReview } from '../types.js'
import { Candle } from '../market/index.js'

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

export function fmtOffsetLabel(offsetHours: number): string {
  if (offsetHours === 0) return 'UTC'
  const sign = offsetHours > 0 ? '+' : '-'
  const abs = Math.abs(offsetHours)
  const h = Math.floor(abs)
  const m = Math.round((abs - h) * 60)
  return m > 0 ? `UTC${sign}${h}:${m.toString().padStart(2, '0')}` : `UTC${sign}${h}`
}

export function fmtPrice(n: number): string {
  if (!isFinite(n) || n === 0) return '0'
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  if (n >= 0.01) return n.toFixed(6)
  return n.toPrecision(5)
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
  useHorizon = true,
  utcOffsetHours = 0,
  candles: Candle[] = [],
  candleTf = '1h',
): { system: string; user: string } {
  const effectiveHorizon: 'short' | 'medium' | 'long' =
    (position.horizon === 'disabled' || position.horizon === 'llm') ? 'medium' : position.horizon
  const cfg = horizonConfigs[effectiveHorizon]
  const horizonBehavior = HORIZON_BEHAVIOR[effectiveHorizon]

  const horizonSection = useHorizon ? `
── Horizon: ${position.horizon.toUpperCase()} ─────────────────────────────────────────────────────
${horizonBehavior}

── Configured SL/TP targets for ${position.horizon.toUpperCase()} ──────────────────────────────────
  Stop-loss target:   -${cfg.slPct.toFixed(1)}% from current price
  Take-profit target: +${cfg.tpPct.toFixed(1)}% from current price
  These are the owner's risk preferences.
  - If the current SL is not yet set, propose new_stop_loss_pct = -${cfg.slPct.toFixed(1)} (or tighter if price has moved up).
  - If the current TP is not yet set, propose new_take_profit_pct = +${cfg.tpPct.toFixed(1)} (or higher if price has moved up).
  - When trailing the stop, aim to stay near -${cfg.slPct.toFixed(1)}% from the recent high, not from entry.
` : ''

  const breakEvenTrigger = useHorizon ? (cfg.tpPct / 2).toFixed(1) : '3.0'

  const profitProtection = `── Profit protection (apply in order) ───────────────────────────────────────
- Once P&L ≥ +${breakEvenTrigger}%, the stop must sit at break-even or better (SL ≥ entry price).
  If it doesn't, ADJUST now — never let a meaningful winner turn into a loser.
- While in profit, the stop only ratchets UP. Never widen the SL or lower the TP of a winning position.
- Lock gains against the price structure: trail under the most recent higher low or SMA7,
  not a fixed % below a spike high.`

  const hardRules = useHorizon
    ? `${profitProtection}

── Hard risk rules (engine-enforced) ────────────────────────────────────────
- Stop-loss loosening is capped at -${cfg.slPct.toFixed(1)}% from current price (the horizon floor).
  Only loosen when volatility has expanded or the original stop was structurally wrong.
  Prefer tightening (trailing) when the trend is intact.
- new_stop_loss_pct must be negative (below current price); new_take_profit_pct must be positive.
- Base levels on ATR(14), SMA7, SMA25, and entry price. Skip trivial tweaks (<0.5% moves).`
    : `${profitProtection}

── Hard risk rules (engine-enforced) ────────────────────────────────────────
- new_stop_loss_pct must be negative (below current price); new_take_profit_pct must be positive.
- Base levels on ATR(14), SMA7, SMA25, and entry price. Skip trivial tweaks (<0.5% moves).`

  const adjustSeedNote = useHorizon
    ? 'untouched side as-is (or seeds it from the horizon target if none exists),'
    : 'untouched side as-is (or seeds it from ATR/SMAs if none exists),'

  const system = `You are a professional crypto trading risk manager. Review one open long position and recommend exactly one action: HOLD, ADJUST, REDUCE, or CLOSE.

── Actions ──────────────────────────────────────────────────────────────────
CLOSE      Exit entirely. Use when SL is imminent (<2% away), trend reversed to downtrend
           with negative momentum, or deeply underwater with no recovery signals.
REDUCE     Partial exit. Set reduce_to_pct (integer: % of current size to keep, e.g. 50 = keep half).
           Use to lock in gains near TP, or to de-risk a weakening position.
ADJUST     Keep the position but update stop-loss and/or take-profit.
           Use to trail the stop UP as price rises, extend TP in a strong trend,
           or tighten risk when momentum weakens.
           Express BOTH levels as PERCENTAGES relative to the CURRENT price (never
           absolute USD, never relative to entry):
             new_stop_loss_pct   — negative = below current price (e.g. -3.5 → SL 3.5% below)
             new_take_profit_pct — positive = above current price (e.g. +8.0 → TP 8% above)
           Adjust just one side by setting the other to null — the engine keeps the
           ${adjustSeedNote}
           so a complete stop+target pair is always maintained. The "Stop"/"TP" lines
           below are already shown in this same %-from-current-price frame: to leave a
           level unchanged, repeat its shown value; do not echo it as a fresh change.
HOLD       No change. Trend intact, SL buffer healthy, no compelling reason to act.

── Decision consistency ──────────────────────────────────────────────────────
The past 3 decisions are provided for context. Use them to:
- Avoid flip-flopping: if you just HOLDed and nothing structural has changed, HOLD again.
- Recognize a trend: repeated HOLD + rising price → trail the stop UP (ADJUST), don't keep holding a stale SL.
- Not repeat the same ADJUST twice in a row if price barely moved since the last one.
${horizonSection}
${hardRules}

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
  let candleHistoryText = ''
  if (candles.length > 0) {
    const nowSec = Math.floor(Date.now() / 1000)
    const rows = candles.map(c => {
      const ageSec = nowSec - c.time
      const ageH = ageSec / 3600
      let ageLabel: string
      if (ageH < 1) ageLabel = `${Math.round(ageSec / 60)}m ago`
      else if (ageH < 24) ageLabel = `${Math.round(ageH)}h ago`
      else ageLabel = `${Math.round(ageH / 24)}d ago`

      const chPct = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0
      const chSign = chPct >= 0 ? '+' : ''
      const vol = c.volume >= 1_000_000
        ? `${(c.volume / 1_000_000).toFixed(1)}M`
        : c.volume >= 1_000
          ? `${(c.volume / 1_000).toFixed(0)}K`
          : c.volume.toFixed(0)
      return `  ${ageLabel.padEnd(8)} O:${fmtPrice(c.open).padEnd(10)} H:${fmtPrice(c.high).padEnd(10)} L:${fmtPrice(c.low).padEnd(10)} C:${fmtPrice(c.close).padEnd(10)} vol:${vol.padEnd(7)} Δ:${chSign}${chPct.toFixed(2)}%`
    })
    candleHistoryText = `\n\n── Price history (${candleTf} candles, oldest→newest) ─────────────────────────
${rows.join('\n')}`
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

  const user = `Review this open position and recommend an action:\n\n${positionText}${candleHistoryText}${prevDecisionText}\n\nRespond with a single JSON object.`

  return { system, user }
}
