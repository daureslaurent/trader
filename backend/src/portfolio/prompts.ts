import { MarketContext, PortfolioState, BotSettings } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'
import { CoinPortfolioContext } from './service.js'
import { OrderBookAnalysis } from '../trader/types.js'
import { MarketRegime } from './market.js'
import { Candle, renderCandleTable } from '../market/index.js'

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
  chooseHorizon = false,
  candles: Candle[] = [],
  candleTf = '1h',
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

PROFIT DISCIPLINE
- Every round trip costs ~0.2% in fees plus slippage. Only trade when the expected edge clearly exceeds that cost; HOLD is the correct call on most cycles. Overtrading erodes returns faster than missed moves.
- Trade WITH the regime. The best long entries are pullbacks toward SMA7/SMA25 within an uptrend — not vertical green candles, not falling knives.
- Read the recent price-history candles (when shown) to confirm the setup: where price sits relative to recent swing highs/lows, whether the move is extended or basing, and whether volume backs the move. Let the bars corroborate the indicators — don't buy into a vertical spike or sell into a clean higher-low structure.

BUY only when ALL of these hold:
- MEDIUM/HIGH confidence, a free slot, and regime + catalyst aligned in your favour.
- Not chasing: avoid buying when momentum is overbought (RSI ≥ 70) or price is stretched far above SMA7 after a sharp run — that is where pumps top out.
- In a downtrend or ranging regime, a BUY needs a concrete fresh catalyst (adoption, upgrade, listing, partnership) — oversold alone is not a reason.

SELL only when:
- A clear negative catalyst (hack, regulatory action, broken fundamentals), a confirmed trend reversal against the position, or severe overextension. Ordinary downside is already covered by the stop-loss — do not SELL on noise.
- Never SELL a coin not held. Never add to a losing position unless the thesis has materially improved.

HOLD when signals are mixed or conviction is low — a missed move beats a bad trade.

CONFIDENCE — calibrate honestly; defaulting everything to MEDIUM makes the field useless:
- HIGH: regime, technicals, AND a concrete fresh catalyst all align, the entry is a pullback
  (not a chase), and nothing material argues against the trade. Rare — expect roughly 1 in 10.
- MEDIUM: regime and technicals align but the catalyst is generic or stale, or exactly one
  minor factor conflicts.
- LOW: weak or conflicting — prefer HOLD.
Consistency rules: if regime and technicals disagree, confidence cannot be HIGH. If two or
more of {regime, technicals, news} argue against the trade, it must be LOW.
${chooseHorizon ? `
HORIZON — on a BUY, classify the trade thesis by how long you expect it to play out. This sets
how the position is sized and managed, so match it to the catalyst, not to your confidence:
- "short" (days–weeks): momentum/event-driven — a listing, a pump, a near-term catalyst whose
  effect fades fast. Tight stops, quick profit-taking. Use when the edge is a fleeting move.
- "medium" (weeks–months): a swing within an established trend — a pullback entry in an uptrend,
  a developing narrative. The default for most ordinary trend-following entries.
- "long" (months+): a structural conviction thesis — durable adoption, a fundamental re-rating —
  where short-term noise should not shake you out. Reserve for genuine long-horizon catalysts.
` : ''}
OUTPUT — JSON only, no markdown, no extra keys:
{"action":"BUY|SELL|HOLD","confidence":"HIGH|MEDIUM|LOW",${chooseHorizon ? '"horizon":"short|medium|long",' : ''}"reason":"<1-2 sentences: regime → technicals → news → position fit → decision>"}${chooseHorizon ? '\n("horizon" is required on BUY; omit or ignore it for SELL/HOLD.)' : ''}`

  // ── User prompt — compact fact sheet ────────────────────────────────────────

  const ch24 = `${market.change24h > 0 ? '+' : ''}${market.change24h.toFixed(2)}%`
  const p7 = `${market.perf7d > 0 ? '+' : ''}${market.perf7d.toFixed(2)}%`

  const orderBookLine = orderBook
    ? `\nLiquidity: ${orderBook.liquidityScore.toUpperCase()} (spread ${orderBook.spreadPct.toFixed(3)}%)`
    : ''

  const volM = `$${(market.volume / 1_000_000).toFixed(1)}M`
  const stretchPct = market.sma7 > 0 ? ((market.price - market.sma7) / market.sma7 * 100) : 0

  const candleTable = renderCandleTable(candles, candleTf)
  const candleBlock = candleTable ? `\n\n${candleTable}` : ''

  const user = `COIN: ${coin.replace('/USDC', '')}

REGIME (precomputed): ${regime.summary}
Price $${market.price} | 24h ${ch24} | 7d ${p7} | 24h vol ${volM}
SMA7 $${market.sma7} (price ${stretchPct >= 0 ? '+' : ''}${stretchPct.toFixed(2)}% vs SMA7) | SMA25 $${market.sma25}${market.sma99 ? ` | SMA99 $${market.sma99}` : ''} | ATR14 $${market.atr14}${orderBookLine}${candleBlock}

POSITION: ${coinPositionBlock}
PORTFOLIO: ${portfolio.openPositionCount}/${portfolio.maxOpenPositions} slots used (${openSlots} free) | other holdings: ${otherPositionsList}

NEWS (sentiment ${research.aggregated_sentiment}):
${articlesText}

Decide BUY / SELL / HOLD for ${coin.replace('/USDC', '')}.`

  return { system, user }
}
