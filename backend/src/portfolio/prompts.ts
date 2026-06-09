import { MarketContext, PortfolioState, BotSettings } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'
import { CoinPortfolioContext } from './service.js'
import { OrderBookAnalysis } from '../trader/types.js'
import { MarketRegime } from './market.js'

/**
 * Build the decision prompt for the analyst LLM.
 *
 * Scope (to_fix.md #1): the LLM is asked for ONE judgement — BUY / SELL / HOLD
 * plus a confidence band and a short reason. Market-regime classification is
 * already computed deterministically (`classifyRegime`) and SL/TP sizing is
 * computed deterministically (`computeRiskLevels`); both are handed to the model
 * as facts, not asked of it. This keeps the prompt small, runs at a single low
 * temperature, and prevents a bad regime read from cascading into direction/risk.
 */
export function buildAnalysisPrompt(
  coin: string,
  market: MarketContext,
  regime: MarketRegime,
  portfolio: PortfolioState,
  settings: BotSettings,
  research: ExtractedResearch,
  coinCtx: CoinPortfolioContext,
  orderBook: OrderBookAnalysis | null = null,
): { system: string; user: string } {
  const now = new Date().toISOString().split('T')[0]

  // ── Portfolio context ────────────────────────────────────────────────────

  const openSlots = portfolio.maxOpenPositions - portfolio.openPositionCount
  const otherPositions = portfolio.positions.filter(p => p.coin !== coin)
  const otherPositionsList = otherPositions.length === 0
    ? 'None'
    : otherPositions.map(p => `${p.coin.replace('/USDC', '')} ${(p.allocationPct * 100).toFixed(0)}%`).join(', ')

  // ── Current coin position ────────────────────────────────────────────────

  const isHolding = coinCtx.currentQuantity > 0 && coinCtx.avgBuyPrice != null
  const coinPositionBlock = isHolding
    ? (() => {
        const avg = coinCtx.avgBuyPrice!
        const unrealizedPct = ((market.price - avg) / avg * 100)
        const sign = unrealizedPct >= 0 ? '+' : ''
        return `HOLDING ${coinCtx.currentQuantity} @ avg $${avg.toFixed(4)} (${sign}${unrealizedPct.toFixed(2)}% unrealized)`
      })()
    : 'NO POSITION'

  // ── News ─────────────────────────────────────────────────────────────────

  const articlesText = research.articles.length === 0
    ? 'No article data.'
    : research.articles.slice(0, 4).map(a => {
        const sig = a.preliminary_signal ? ` [${a.preliminary_signal}]` : ''
        return `• ${a.title}${sig} (${a.sentiment}, ${Math.round(a.relevance_score * 100)}% rel): ${a.summary}`
      }).join('\n')

  // ── System prompt — small, single-purpose ──────────────────────────────────

  const system = `You are a crypto trading decision engine. Date: ${now}.
The market regime, technical indicators, and risk levels are ALREADY computed and given to you as facts — do not recompute or second-guess them. Decide only ONE thing: whether to BUY, SELL, or HOLD this coin now.

RULES
- BUY only with MEDIUM/HIGH confidence, a free slot, and regime + catalysts aligned in your favour.
- SELL only on a clear negative catalyst, severe overextension, or an imminent stop-out. Never SELL a coin not held.
- HOLD when signals are mixed or conviction is low — a missed move beats a bad trade.
- Never add to a losing position unless the thesis has materially improved.

CONFIDENCE
- HIGH: multiple confirming factors and a clear catalyst.
- MEDIUM: a moderate edge with reasonable risk/reward.
- LOW: weak or conflicting — prefer HOLD.

OUTPUT — JSON only, no markdown, no extra keys:
{"action":"BUY|SELL|HOLD","confidence":"HIGH|MEDIUM|LOW","reason":"<1-2 sentences: regime → technicals → news → position fit → decision>"}`

  // ── User prompt — compact fact sheet ────────────────────────────────────────

  const ch24 = `${market.change24h > 0 ? '+' : ''}${market.change24h.toFixed(2)}%`
  const p7 = `${market.perf7d > 0 ? '+' : ''}${market.perf7d.toFixed(2)}%`

  const orderBookLine = orderBook
    ? `\nLiquidity: ${orderBook.liquidityScore.toUpperCase()} (spread ${orderBook.spreadPct.toFixed(3)}%)`
    : ''

  const user = `COIN: ${coin.replace('/USDC', '')}

REGIME (precomputed): ${regime.summary}
Price $${market.price} | 24h ${ch24} | 7d ${p7}
SMA7 $${market.sma7} | SMA25 $${market.sma25}${market.sma99 ? ` | SMA99 $${market.sma99}` : ''} | ATR14 $${market.atr14}${orderBookLine}

POSITION: ${coinPositionBlock}
PORTFOLIO: ${portfolio.openPositionCount}/${portfolio.maxOpenPositions} slots used (${openSlots} free) | other holdings: ${otherPositionsList}

NEWS (sentiment ${research.aggregated_sentiment}):
${articlesText}

Decide BUY / SELL / HOLD for ${coin.replace('/USDC', '')}.`

  return { system, user }
}
