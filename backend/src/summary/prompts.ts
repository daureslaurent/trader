// ── Formatting helpers ───────────────────────────────────────────────────────

export function fmtOffsetLabel(offsetHours: number): string {
  if (offsetHours === 0) return 'UTC'
  const sign = offsetHours > 0 ? '+' : '-'
  const abs = Math.abs(offsetHours)
  const h = Math.floor(abs)
  const m = Math.round((abs - h) * 60)
  return m > 0 ? `UTC${sign}${h}:${m.toString().padStart(2, '0')}` : `UTC${sign}${h}`
}

function fmtPrice(n: number): string {
  if (!isFinite(n) || n === 0) return '0'
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  if (n >= 0.01) return n.toFixed(6)
  return n.toPrecision(5)
}

// ── Context shapes fed to the portfolio-summary LLM ──────────────────────────

export interface SummaryHolding {
  coin: string
  quantity: number
  avgBuyPrice: number | null
  currentPrice: number
  valueUsd: number
  allocationPct: number
  unrealizedPnlUsd: number | null
  unrealizedPnlPct: number | null
  change24h: number
  rsi14: number
  trend: 'uptrend' | 'downtrend' | 'ranging'
  volatility: 'high' | 'normal' | 'low'
  regime: string
  stopLoss: number | null
  takeProfit: number | null
  horizon: string | null
  source: string
}

export interface SummaryTrade {
  side: 'BUY' | 'SELL'
  coin: string
  quantity: number
  price: number
  total: number
  date: string
}

export interface SummaryClosed {
  coin: string
  status: string
  entryPrice: number | null
  exitPrice: number | null
  realizedPnl: number | null
  closedAt: string
}

export interface SummaryMonitorAction {
  coin: string
  action: 'HOLD' | 'CLOSE' | 'ADJUST'
  confidence: number
  reasoning: string
  newStopLoss: number | null
  newTakeProfit: number | null
  createdAt: string
}

export interface SummaryContext {
  generatedAt: string
  totalValueUsd: number
  usdcBalance: number
  usdcPct: number
  holdingsCount: number
  openBotPositions: number
  maxOpenPositions: number
  feeRatePct: number
  /** Oldest → newest portfolio total-value snapshots for the trend. */
  valueTrend: { date: string; value: number }[]
  valueChangePct: number | null
  holdings: SummaryHolding[]
  recentTrades: SummaryTrade[]
  recentlyClosed: SummaryClosed[]
  /** Recent decisions from the position-monitor engine (HOLD/CLOSE/ADJUST). */
  monitorActions: SummaryMonitorAction[]
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtPct(n: number | null): string {
  if (n == null || !isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

const SYSTEM = `You are the portfolio strategist for an automated crypto trading bot that trades <COIN>/USDC pairs on Binance. You receive the current portfolio, live Binance market data per holding (price, 24h change, RSI, trend, volatility regime), the bot's open protective orders (stop-loss / take-profit), the recent trade log, recently closed positions with realized P&L, and the latest decisions from the bot's position-monitor engine (HOLD/CLOSE/ADJUST and why).

Write a clear, useful briefing for the human operator. Be concrete and quantitative — cite real numbers, coins, and percentages from the data. Do not invent prices or events that aren't in the data. Explain WHAT HAS HAPPENED recently (fills, exits, gains/losses, notable price moves, and what the position monitor decided — e.g. tightened a stop, trimmed, or closed — and its stated reasoning) and WHY the portfolio looks the way it does, then assess health and risk and give actionable suggestions.

Respond with ONLY a JSON object (no markdown fences) of this exact shape:
{
  "summary": "2-4 sentence prose overview of the portfolio's current state and positioning",
  "what_happened": "2-4 sentences explaining recent activity: trades executed, positions closed, realized P&L, and notable Binance price/RSI/trend moves since the last review. If nothing material happened, say so plainly.",
  "health": "strong | stable | cautious | at_risk",
  "risk_level": "low | moderate | elevated | high",
  "observations": ["short factual bullet", "..."],
  "suggestions": ["short actionable bullet", "..."]
}

Keep "observations" and "suggestions" to 3-6 concise bullets each. Risk should weigh concentration (allocation %), unrealized drawdowns, overbought/oversold RSI, downtrends, and missing stop-losses.`

export function buildSummaryPrompt(ctx: SummaryContext): { system: string; user: string } {
  const lines: string[] = []

  lines.push(`# PORTFOLIO SNAPSHOT — ${ctx.generatedAt}`)
  lines.push('')
  lines.push(`Total value: ${fmtUsd(ctx.totalValueUsd)}`)
  lines.push(`USDC (cash): ${fmtUsd(ctx.usdcBalance)} (${ctx.usdcPct.toFixed(1)}% of portfolio)`)
  lines.push(`Holdings: ${ctx.holdingsCount} coin position(s) · Bot-managed open positions: ${ctx.openBotPositions}/${ctx.maxOpenPositions}`)
  lines.push(`Exchange fee per side: ${ctx.feeRatePct.toFixed(3)}%`)

  if (ctx.valueTrend.length >= 2) {
    const trendStr = ctx.valueTrend.map(s => `${s.date}=${fmtUsd(s.value)}`).join('  ')
    lines.push('')
    lines.push(`Portfolio value trend (oldest→newest): ${trendStr}`)
    lines.push(`Change over window: ${fmtPct(ctx.valueChangePct)}`)
  }

  lines.push('')
  lines.push('## HOLDINGS (with live Binance market data)')
  if (ctx.holdings.length === 0) {
    lines.push('None — the portfolio is fully in USDC.')
  } else {
    for (const h of ctx.holdings) {
      const coin = h.coin.replace('/USDC', '')
      lines.push('')
      lines.push(`### ${coin} — ${h.allocationPct.toFixed(1)}% of portfolio (${fmtUsd(h.valueUsd)})`)
      lines.push(`  Qty ${h.quantity} @ avg entry ${h.avgBuyPrice != null ? fmtPrice(h.avgBuyPrice) : '—'} · now ${fmtPrice(h.currentPrice)}`)
      lines.push(`  Unrealized P&L: ${h.unrealizedPnlUsd != null ? fmtUsd(h.unrealizedPnlUsd) : '—'} (${fmtPct(h.unrealizedPnlPct)})`)
      lines.push(`  Market: 24h ${fmtPct(h.change24h)} · RSI14 ${h.rsi14.toFixed(0)} · ${h.regime}`)
      lines.push(`  Protection: SL ${h.stopLoss != null ? fmtPrice(h.stopLoss) : 'none'} · TP ${h.takeProfit != null ? fmtPrice(h.takeProfit) : 'none'} · horizon ${h.horizon ?? '—'} · source ${h.source}`)
    }
  }

  lines.push('')
  lines.push('## RECENT TRADES (newest first)')
  if (ctx.recentTrades.length === 0) {
    lines.push('No trades recorded recently.')
  } else {
    for (const t of ctx.recentTrades) {
      lines.push(`  ${t.date} · ${t.side} ${t.quantity} ${t.coin.replace('/USDC', '')} @ ${fmtPrice(t.price)} (${fmtUsd(t.total)})`)
    }
  }

  lines.push('')
  lines.push('## RECENTLY CLOSED POSITIONS (realized P&L)')
  if (ctx.recentlyClosed.length === 0) {
    lines.push('No positions closed recently.')
  } else {
    for (const c of ctx.recentlyClosed) {
      lines.push(`  ${c.closedAt} · ${c.coin.replace('/USDC', '')} ${c.status} · entry ${c.entryPrice != null ? fmtPrice(c.entryPrice) : '—'} → exit ${c.exitPrice != null ? fmtPrice(c.exitPrice) : '—'} · realized ${c.realizedPnl != null ? fmtUsd(c.realizedPnl) : '—'}`)
    }
  }

  lines.push('')
  lines.push('## POSITION MONITOR — recent decisions (newest first)')
  if (ctx.monitorActions.length === 0) {
    lines.push('No monitor reviews recorded recently.')
  } else {
    for (const a of ctx.monitorActions) {
      const coin = a.coin.replace('/USDC', '')
      const detail =
        a.action === 'ADJUST'
          ? ` → ${[a.newStopLoss != null ? `SL ${fmtPrice(a.newStopLoss)}` : null, a.newTakeProfit != null ? `TP ${fmtPrice(a.newTakeProfit)}` : null].filter(Boolean).join(' · ') || 'SL/TP'}`
          : ''
      const reason = a.reasoning.length > 220 ? a.reasoning.slice(0, 220) + '…' : a.reasoning
      lines.push(`  ${a.createdAt} · ${coin} ${a.action}${detail} (conf ${a.confidence.toFixed(2)}): ${reason}`)
    }
  }

  lines.push('')
  lines.push('Produce the JSON briefing now.')

  return { system: SYSTEM, user: lines.join('\n') }
}
