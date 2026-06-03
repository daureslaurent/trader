import { ResearchResult } from '../researcher/index.js'

export function buildAnalysisPrompt(
  coin: string,
  price: number,
  change24h: number,
  volume: number,
  research: ResearchResult,
  portfolioPercent: number,
): { system: string; user: string } {
  const system = `You are a conservative crypto portfolio manager. Analyze the given data and respond with ONLY a JSON object.
Rules:
- Only recommend BUY if confidence > 0.6
- Only recommend SELL if the coin has negative news AND is over 5% of portfolio
- Prefer HOLD over uncertain trades
- quantity should be in the base coin (e.g. BTC, ETH, SOL)
- Keep position sizes reasonable (max 100 USDT worth)`

  const user = `Coin: ${coin}
Price: $${price}
24h Change: ${change24h}%
Volume: $${volume}
Portfolio Allocation: ${portfolioPercent.toFixed(1)}%
News: ${research.summary}

Respond with JSON only:
{ "action": "BUY"|"SELL"|"HOLD", "coin": "${coin}", "quantity": number, "reason": "string", "confidence": 0.0-1.0 }`

  return { system, user }
}
