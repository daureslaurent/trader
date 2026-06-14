import { Candle } from './ohlcv.js'

/**
 * Format a price as a compact string with precision scaled to magnitude — used
 * wherever prices are rendered into LLM prompts so the model sees consistent,
 * readable numbers regardless of the coin's order of magnitude.
 */
export function fmtPrice(n: number): string {
  if (!isFinite(n) || n === 0) return '0'
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  if (n >= 0.01) return n.toFixed(6)
  return n.toPrecision(5)
}

/**
 * Render an OHLCV series as a fixed-width text table for an LLM prompt,
 * oldest→newest. Each row is tagged with its relative age, intrabar % change and
 * abbreviated volume so the model can read recent price structure (swing highs/
 * lows, momentum, expansion) without parsing raw timestamps. Returns '' for an
 * empty series; the header names the timeframe so each row's duration is explicit.
 */
export function renderCandleTable(candles: Candle[], tf: string): string {
  if (candles.length === 0) return ''
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
  return `── Price history (${tf} candles, oldest→newest) ─────────────────────────
${rows.join('\n')}`
}
