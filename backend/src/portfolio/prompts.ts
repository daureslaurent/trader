import { MarketContext, PortfolioState, BotSettings } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'

export function buildAnalysisPrompt(
  coin: string,
  market: MarketContext,
  portfolio: PortfolioState,
  settings: BotSettings,
  research: ExtractedResearch,
): { system: string; user: string } {
  const system = `You are an autonomous crypto portfolio manager. You manage a portfolio with discipline and patience.

KEY RULES (non-negotiable):
- Only BUY if conviction > 0.6 AND the coin fits portfolio diversification
- Only SELL if: negative catalyst, OR position exceeds target allocation meaningfully
- Prefer HOLD over uncertain trades. Missing a move is better than taking a bad trade.
- Position sizing: scale quantity proportionally to your confidence
- Medium-term horizon: decisions are evaluated over days to weeks

PORTFOLIO STATE:
- Total portfolio value: $${portfolio.totalValueUsd.toFixed(2)}
- Current open positions: ${portfolio.openPositionCount} / ${portfolio.maxOpenPositions}
- Target allocation per coin: ${(portfolio.targetAllocationPct * 100).toFixed(1)}%
- Diversification score: ${portfolio.diversificationScore.toFixed(2)} (0=poor, 1=perfect)

OPEN POSITIONS:
${portfolio.positions.length === 0 ? 'None' : portfolio.positions.map(p =>
  `- ${p.coin}: ${(p.allocationPct * 100).toFixed(1)}% of portfolio, PnL: ${p.pnlPct > 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%`
).join('\n')}

OUTPUT FORMAT — respond with ONLY a JSON object:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0.0-1.0,
  "reasoning": "concise explanation of your logic",
  "suggested_position_size_usd": number
}`

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
- RSI(14): ${market.rsi14}
- SMA(7): $${market.sma7}
- SMA(25): $${market.sma25}
- SMA(99): $${market.sma99}
- ATR(14): $${market.atr14}
- Trend: ${market.trend}
- 7d Performance: ${market.perf7d > 0 ? '+' : ''}${market.perf7d}%
- Volatility: ${market.volatility}

NEWS:
Aggregated Sentiment: ${research.aggregated_sentiment}
Top Headlines: ${research.top_headlines.join('. ')}

Articles:${articlesText}

Decide: BUY, SELL, or HOLD for ${coin}?`

  return { system, user }
}
