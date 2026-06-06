import { MarketContext, PortfolioState, BotSettings } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'
import { CoinPortfolioContext } from './service.js'
import { calculateBreakEven } from './risk.js'

export function buildAnalysisPrompt(
  coin: string,
  market: MarketContext,
  portfolio: PortfolioState,
  settings: BotSettings,
  research: ExtractedResearch,
  coinCtx: CoinPortfolioContext,
): { system: string; user: string } {
  const now = new Date().toISOString().split('T')[0]

  const feeRate = settings.fee_rate ?? 0.001
  const feeRatePct = (feeRate * 100).toFixed(3)
  const roundTripFeePct = (feeRate * 2 * 100).toFixed(3)
  const breakEvenPrice = calculateBreakEven(market.price, feeRate)
  const breakEvenPct = ((breakEvenPrice - market.price) / market.price * 100).toFixed(3)

  const slDistancePct = ((settings.stop_loss_atr * market.atr14) / market.price) * 100
  const tpDistancePct = ((settings.take_profit_atr * market.atr14) / market.price) * 100
  const impliedRR = settings.take_profit_atr / settings.stop_loss_atr

  const positionsList = portfolio.positions.length === 0
    ? 'None'
    : portfolio.positions.map(p => {
        const deltaSign = p.deltaPct > 0 ? '+' : ''
        return `- ${p.coin}: ${(p.allocationPct * 100).toFixed(1)}% of portfolio, bought at $${p.entryPrice.toFixed(2)}, now $${p.currentPrice.toFixed(2)}, delta: ${deltaSign}${p.deltaPct.toFixed(1)}%`
      }).join('\n')

  const coinHoldingLine = coinCtx.currentQuantity > 0 && coinCtx.avgBuyPrice !== null
    ? `Holding ${coinCtx.currentQuantity} ${coin} @ avg $${coinCtx.avgBuyPrice.toFixed(4)} (delta: ${((market.price - coinCtx.avgBuyPrice) / coinCtx.avgBuyPrice * 100).toFixed(1)}%)`
    : `No current position in ${coin}`

  const recentTradesLine = coinCtx.recentTrades.length === 0
    ? 'No prior trades on this coin'
    : coinCtx.recentTrades
        .map(t => `${t.date} ${t.side} ${t.quantity} @ $${t.price}`)
        .join('\n')

  const system = `You are an autonomous crypto portfolio manager. You manage a portfolio with discipline and patience. Date: ${now}.

KEY RULES:
- Only BUY if confidence is MEDIUM or HIGH AND the coin fits portfolio diversification
- Only SELL if: negative catalyst, OR position exceeds target allocation meaningfully
- Prefer HOLD over uncertain trades. Missing a move is better than taking a bad trade.
- Medium-term horizon: decisions play out over days to weeks

TECHNICAL THRESHOLDS:
- RSI < 30: oversold (potential bounce zone)
- RSI > 70: overbought (potential top zone)
- SMA(7) > SMA(25) > SMA(99): bullish alignment
- SMA(7) < SMA(25) < SMA(99): bearish alignment
- High ATR relative to price = wide stop-loss needed, each position carries more risk

PORTFOLIO STATE:
- Total value: $${portfolio.totalValueUsd.toFixed(2)}
- Open positions: ${portfolio.openPositionCount} / ${portfolio.maxOpenPositions}
- Target allocation per coin: ${(portfolio.targetAllocationPct * 100).toFixed(1)}%
- Diversification score: ${portfolio.diversificationScore.toFixed(2)} (0=poor, 1=perfect)

OPEN POSITIONS:
${positionsList}

THIS COIN — LOCAL PORTFOLIO:
${coinHoldingLine}
Recent trades:
${recentTradesLine}

FEE CONTEXT:
- Exchange fee rate: ${feeRatePct}% per trade
- Round-trip cost (buy + sell): ${roundTripFeePct}% of position value
- Break-even sell price if buying now: $${breakEvenPrice.toFixed(4)} (+${breakEvenPct}% above current price)
- Factor fees into expected gain — a ${roundTripFeePct}% move up just breaks even

RISK ASSESSMENT FOR THIS TRADE:
- Stop-loss would be ${slDistancePct.toFixed(1)}% below entry (${slDistancePct < 3 ? 'tight — higher whip risk' : 'reasonable distance'})
- Take-profit would be ${tpDistancePct.toFixed(1)}% above entry
- Implied risk/reward ratio: 1:${impliedRR.toFixed(1)}
- Volatility: ${market.volatility} — ${market.volatility === 'high' ? 'expect wider swings, reduce position sizing' : market.volatility === 'low' ? 'tight ranges, smaller relative moves' : 'normal trading conditions'}

OUTPUT FORMAT — respond with ONLY a JSON object, no markdown:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reason": "step-by-step reasoning: market setup → technical setup → news analysis → portfolio fit → risk assessment → decision"
}

CONFIDENCE LEVELS:
- HIGH: multiple confirming factors, clear catalyst, strong conviction
- MEDIUM: moderate signal, some uncertainty, reasonable risk/reward
- LOW: weak or conflicting signals — prefer HOLD instead`

  const articlesText = research.articles.length > 0
    ? research.articles.map(a =>
        `\n--- ${a.title} ---\nRelevance: ${a.relevance_score}\nSentiment: ${a.sentiment}\nSummary: ${a.summary}\nKey Points: ${a.key_points.join(', ')}`
      ).join('\n')
    : 'No article data available.'

  const user = `ANALYZE: ${coin}

MARKET DATA:
- Price: $${market.price}
- 24h Change: ${market.change24h > 0 ? '+' : ''}${market.change24h}%
- Volume: $${market.volume}
- RSI(14): ${market.rsi14} (${market.rsi14 < 30 ? 'oversold' : market.rsi14 > 70 ? 'overbought' : 'neutral'})
- SMA(7): $${market.sma7}
- SMA(25): $${market.sma25}
- SMA(99): $${market.sma99}
- Trend: ${market.trend} ${market.trend === 'uptrend' ? '(SMA7 > SMA25)' : market.trend === 'downtrend' ? '(SMA7 < SMA25)' : '(SMAs flat)'}
- ATR(14): $${market.atr14}
- 7d Performance: ${market.perf7d > 0 ? '+' : ''}${market.perf7d}%

NEWS:
Aggregated Sentiment: ${research.aggregated_sentiment}
Top Headlines: ${research.top_headlines.join('. ')}

Articles:${articlesText}

Decide: BUY, SELL, or HOLD for ${coin}?
Chain: market setup → technical analysis → news catalysts → portfolio fit → risk/reward → final decision`

  return { system, user }
}
