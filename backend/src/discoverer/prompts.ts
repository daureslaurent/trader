import { MarketContext } from '../types.js'
import { ExtractedArticle } from '../extractor/types.js'

export interface DiscoveryResearch {
  headlines: string[]
  aggregated_sentiment: 'positive' | 'negative' | 'neutral'
  articles: ExtractedArticle[]
}

export function buildDiscoveryPrompt(
  symbol: string,
  market: MarketContext,
  research?: DiscoveryResearch,
): { system: string; user: string } {
  const system = `You are a quantitative crypto trading assistant evaluating whether a coin is worth adding to an automated trading bot's watchlist.

The bot:
- Trades on Binance with USDC
- Uses momentum, RSI, and trend signals
- Requires good liquidity (high 24h volume)
- Prefers coins with clear directional trends over choppy/ranging markets
- Avoids extremely overbought coins (RSI > 80) or extremely oversold without reversal signals

Return ONLY valid JSON with this exact schema:
{
  "score": <number between 0.0 and 1.0>,
  "reasoning": "<one or two concise sentences>"
}

Scoring guide:
- 0.80–1.00: Strong candidate — high liquidity, established uptrend with RSI 40–65 (room to run), price near or pulling back toward SMA7/SMA25, positive news sentiment
- 0.60–0.80: Good candidate — meets most criteria with minor concerns
- 0.40–0.60: Marginal — lacks trend clarity, mixed news, or notable risks
- 0.00–0.40: Not recommended — too volatile, low volume, overbought, negative news, or poor setup

Anti-chasing rules (override the guide above):
- A large 24h pump (> +10%) with RSI > 70 means the entry is late, not strong — cap the score at 0.40
- A pullback within an intact uptrend scores HIGHER than a fresh vertical breakout
- Down-trending coins need a concrete bullish catalyst in the news to score above 0.40; oversold alone is not a setup`

  const coin = symbol.replace('/USDC', '')

  let researchSection = ''
  if (research) {
    const headlines = research.headlines.slice(0, 5)
    const articles = research.articles.filter(a => a.relevance_score >= 0.3).slice(0, 3)
    researchSection = `
News sentiment: ${research.aggregated_sentiment}
${headlines.length > 0 ? `Recent headlines:\n${headlines.map(h => `- ${h}`).join('\n')}` : 'No recent headlines.'}
${articles.length > 0 ? `\nKey articles:\n${articles.map(a =>
  `- [${a.sentiment.toUpperCase()}] ${a.title}${a.summary ? `: ${a.summary}` : ''}`
).join('\n')}` : ''}`
  }

  const user = `Evaluate ${coin} (${symbol}) for the trading watchlist:

Price: $${market.price.toFixed(6)}
24h change: ${market.change24h >= 0 ? '+' : ''}${market.change24h.toFixed(2)}%
24h volume: $${(market.volume / 1_000_000).toFixed(2)}M
7-day performance: ${market.perf7d >= 0 ? '+' : ''}${market.perf7d.toFixed(2)}%
RSI-14: ${market.rsi14.toFixed(1)}
Trend: ${market.trend}
Volatility: ${market.volatility}
SMA7: $${market.sma7.toFixed(6)} | SMA25: $${market.sma25.toFixed(6)} | SMA99: $${market.sma99.toFixed(6)}
ATR-14: $${market.atr14.toFixed(6)}${researchSection}`

  return { system, user }
}
