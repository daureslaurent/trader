import { MarketContext } from '../types.js'

export function buildDiscoveryPrompt(
  symbol: string,
  market: MarketContext,
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
- 0.80–1.00: Strong candidate — high liquidity, clear trend, favorable RSI, good setup
- 0.60–0.80: Good candidate — meets most criteria with minor concerns
- 0.40–0.60: Marginal — lacks trend clarity or has notable risks
- 0.00–0.40: Not recommended — too volatile, low volume, overbought, or poor setup`

  const coin = symbol.replace('/USDC', '')
  const user = `Evaluate ${coin} (${symbol}) for the trading watchlist:

Price: $${market.price.toFixed(6)}
24h change: ${market.change24h >= 0 ? '+' : ''}${market.change24h.toFixed(2)}%
24h volume: $${(market.volume / 1_000_000).toFixed(2)}M
7-day performance: ${market.perf7d >= 0 ? '+' : ''}${market.perf7d.toFixed(2)}%
RSI-14: ${market.rsi14.toFixed(1)}
Trend: ${market.trend}
Volatility: ${market.volatility}
SMA7: $${market.sma7.toFixed(6)} | SMA25: $${market.sma25.toFixed(6)} | SMA99: $${market.sma99.toFixed(6)}
ATR-14: $${market.atr14.toFixed(6)}`

  return { system, user }
}
