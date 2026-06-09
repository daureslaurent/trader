import { MarketContext, PortfolioState, BotSettings } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'
import { CoinPortfolioContext } from './service.js'
import { OrderBookAnalysis } from '../trader/types.js'

export function buildAnalysisPrompt(
  coin: string,
  market: MarketContext,
  portfolio: PortfolioState,
  settings: BotSettings,
  research: ExtractedResearch,
  coinCtx: CoinPortfolioContext,
  orderBook: OrderBookAnalysis | null = null,
): { system: string; user: string } {
  const now = new Date().toISOString().split('T')[0]

  const horizon = settings.default_horizon
  const slDistancePct = ((settings.stop_loss_atr * market.atr14) / market.price) * 100
  const tpDistancePct = ((settings.take_profit_atr * market.atr14) / market.price) * 100
  const impliedRR = settings.take_profit_atr / settings.stop_loss_atr

  // Per-horizon SL/TP targets (only used when horizon is not 'auto')
  const horizonSlPct = horizon === 'short' ? settings.monitor_sl_pct_short
    : horizon === 'long' ? settings.monitor_sl_pct_long
    : settings.monitor_sl_pct_medium
  const horizonTpPct = horizon === 'short' ? settings.monitor_tp_pct_short
    : horizon === 'long' ? settings.monitor_tp_pct_long
    : settings.monitor_tp_pct_medium

  // ── Portfolio context ────────────────────────────────────────────────────

  const openSlots = portfolio.maxOpenPositions - portfolio.openPositionCount
  const otherPositions = portfolio.positions.filter(p => p.coin !== coin)
  const otherPositionsList = otherPositions.length === 0
    ? 'None'
    : otherPositions.map(p => `- ${p.coin.replace('/USDC', '')}: ${(p.allocationPct * 100).toFixed(1)}%`).join('\n')

  // ── Current coin position ────────────────────────────────────────────────

  const isHolding = coinCtx.currentQuantity > 0 && coinCtx.avgBuyPrice != null
  const coinPositionBlock = isHolding
    ? (() => {
        const avg = coinCtx.avgBuyPrice!
        const costBasis = coinCtx.currentQuantity * avg
        const currentValue = coinCtx.currentQuantity * market.price
        const unrealizedUsd = currentValue - costBasis
        const unrealizedPct = ((market.price - avg) / avg * 100)
        const sign = unrealizedPct >= 0 ? '+' : ''
        return `Status: HOLDING
Quantity: ${coinCtx.currentQuantity}
Avg cost: $${avg.toFixed(4)}
Cost basis: $${costBasis.toFixed(2)}
Current value: $${currentValue.toFixed(2)}
Unrealized P&L: ${sign}$${unrealizedUsd.toFixed(2)} (${sign}${unrealizedPct.toFixed(2)}%)`
      })()
    : 'Status: NO POSITION'

  const recentTradesBlock = coinCtx.recentTrades.length === 0
    ? 'None'
    : coinCtx.recentTrades.map(t => `${t.date} ${t.side} ${t.quantity} @ $${t.price}`).join('\n')

  // ── Market structure ─────────────────────────────────────────────────────

  const smaAlignment = market.sma7 > market.sma25 && market.sma25 > (market.sma99 ?? 0)
    ? 'BULLISH (SMA7 > SMA25 > SMA99)'
    : market.sma7 < market.sma25 && market.sma25 < (market.sma99 ?? Infinity)
      ? 'BEARISH (SMA7 < SMA25 < SMA99)'
      : 'MIXED'

  const rsiLabel = market.rsi14 < 30 ? 'oversold — potential bounce'
    : market.rsi14 > 70 ? 'overbought — caution'
    : 'neutral'

  // ── Articles ─────────────────────────────────────────────────────────────

  const articlesText = research.articles.length === 0
    ? 'No article data available.'
    : research.articles.map(a => {
        const sig = a.preliminary_signal ? ` [${a.preliminary_signal}]` : ''
        const pts = a.key_points.slice(0, 2).map(k => `  → ${k}`).join('\n')
        return `• ${a.title}${sig}
  Relevance: ${Math.round(a.relevance_score * 100)}% | Sentiment: ${a.sentiment}
  ${a.summary}${pts ? '\n' + pts : ''}`
      }).join('\n\n')

  // ── Prompts ───────────────────────────────────────────────────────────────

  const HORIZON_CONTEXT: Record<'short' | 'medium' | 'long', string> = {
    short: `SHORT (days to weeks) — fast in, fast out.
  - Target quick momentum moves; exit on any trend weakness.
  - Tight stops acceptable; smaller TP to cash in quickly.
  - Avoid opening if the setup requires patience.`,
    medium: `MEDIUM (weeks to months) — standard swing trading.
  - Hold through minor pullbacks if trend and RSI are intact.
  - Standard risk management; SL below SMA25, TP at clear resistance.
  - Balance protection vs. normal market noise.`,
    long: `LONG (months to years) — patient conviction positions.
  - Only BUY strong fundamental + technical confluences.
  - Wide stops to survive normal volatility; don't over-trade.
  - Minor dips in an uptrend are noise — only exit on macro reversals.`,
  }

  const horizonSection = horizon === 'auto'
    ? ''
    : `TRADING HORIZON: ${horizon.toUpperCase()}
${HORIZON_CONTEXT[horizon]}

`

  const system = `You are an autonomous crypto portfolio manager making BUY / SELL / HOLD decisions. Date: ${now}.

${horizonSection}DECISION RULES:
- BUY: only if confidence is MEDIUM or HIGH, a free slot exists, and the setup is clearly favourable
- SELL: only if there is a negative catalyst, the position is seriously overextended, or a stop-loss is imminent
- HOLD: default when signals are mixed or conviction is low — missing a move beats taking a bad trade
- Never add to a losing position unless the thesis has materially improved
- Never SELL a coin you are not holding

TECHNICAL SIGNALS:
- RSI < 30 → oversold (watch for reversal); RSI > 70 → overbought (watch for rejection)
- BULLISH alignment: SMA7 > SMA25 > SMA99 | BEARISH: SMA7 < SMA25 < SMA99
- High ATR → wide stop required → each position carries more dollar risk

PORTFOLIO STATE:
- Total value: $${portfolio.totalValueUsd.toFixed(2)}
- Slots: ${portfolio.openPositionCount} open / ${portfolio.maxOpenPositions} max (${openSlots} free)
- Target per coin: ${(portfolio.targetAllocationPct * 100).toFixed(1)}%
- Diversification score: ${portfolio.diversificationScore.toFixed(2)} (0=concentrated, 1=perfect)

OTHER OPEN POSITIONS:
${otherPositionsList}

THIS COIN — ${coin.replace('/USDC', '')}:
${coinPositionBlock}

Recent trades:
${recentTradesBlock}

RISK REFERENCE:
- ATR(14): $${market.atr14} | Volatility: ${market.volatility}
- ATR-based stop-loss: ${slDistancePct.toFixed(1)}% below entry (risk/reward 1:${impliedRR.toFixed(1)})

${horizon === 'auto' ? `STOP-LOSS / TAKE-PROFIT GUIDELINES (for BUY only):
- Calibrate freely to the actual volatility regime:
  - Low volatility / tight range: SL 1.5–3%, TP 3–6%
  - Normal volatility: SL 3–5%, TP 6–12%
  - High volatility / momentum: SL 5–10%, TP 10–20%
- Minimum ratio: TP must be at least 1.5× SL (risk/reward ≥ 1.5)
- Anchor to technical levels when visible (recent swing low for SL, resistance for TP)
- If uncertain, widen slightly rather than being too tight` : `STOP-LOSS / TAKE-PROFIT FOR ${horizon.toUpperCase()} HORIZON (for BUY only):
- Configured targets: SL ${horizonSlPct.toFixed(1)}% below entry, TP ${horizonTpPct.toFixed(1)}% above entry
- These are the owner's preferences — use them as your base, then adjust for volatility:
  - Low volatility: tighten SL by up to 30%, reduce TP proportionally
  - High volatility: widen SL up to 50% to avoid whipsaws, widen TP accordingly
  - Always ensure TP ≥ 1.5× SL (risk/reward ≥ 1.5)
- Anchor to technical levels when visible (recent swing low for SL, resistance for TP)`}

OUTPUT — JSON only, no markdown:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reason": "concise chain: structure → technicals → news → position fit → decision",
  "stop_loss_pct": <number, only for BUY — % below entry price to place stop>,
  "take_profit_pct": <number, only for BUY — % above entry price to place target>
}

CONFIDENCE:
- HIGH: multiple confirming factors, clear catalyst
- MEDIUM: moderate signal, reasonable risk/reward
- LOW: weak or conflicting — prefer HOLD`

  const orderBookSection = orderBook
    ? `ORDER BOOK (live depth snapshot):
- Best bid: $${orderBook.bestBid.toFixed(4)} | Best ask: $${orderBook.bestAsk.toFixed(4)}
- Spread: ${orderBook.spreadPct.toFixed(4)}% | Liquidity: ${orderBook.liquidityScore.toUpperCase()}
- VWAP to fill position: $${orderBook.vwap.toFixed(4)}
- Price impact: ${orderBook.priceImpactPct.toFixed(4)}%
- Suggested limit: $${orderBook.suggestedLimitPrice.toFixed(4)}

`
    : ''

  const user = `ANALYZE: ${coin}

MARKET:
- Price: $${market.price}
- 24h: ${market.change24h > 0 ? '+' : ''}${market.change24h}% | 7d: ${market.perf7d > 0 ? '+' : ''}${market.perf7d}%
- Volume: $${market.volume.toLocaleString()}
- RSI(14): ${market.rsi14.toFixed(1)} — ${rsiLabel}
- SMA alignment: ${smaAlignment}
- SMA7: $${market.sma7} | SMA25: $${market.sma25}${market.sma99 ? ` | SMA99: $${market.sma99}` : ''}
- ATR(14): $${market.atr14} | Trend: ${market.trend} | Volatility: ${market.volatility}

${orderBookSection}NEWS (sentiment: ${research.aggregated_sentiment}):
Headlines: ${research.top_headlines.slice(0, 5).join(' | ')}

Articles:
${articlesText}

Decide BUY / SELL / HOLD for ${coin}.
Reasoning chain: market structure → technical setup → order book liquidity → news catalysts → current position → portfolio fit → decision`

  return { system, user }
}
