import { ExtractedResearch, ExtractedArticle } from '../extractor/index.js'

export function buildAnalysisPrompt(
  coin: string,
  price: number,
  change24h: number,
  volume: number,
  research: ExtractedResearch,
  portfolioPercent: number,
): { system: string; user: string } {
  const system = `You are a conservative crypto portfolio manager. Analyze the given data and respond with ONLY a JSON object.
Rules:
- Only recommend BUY if confidence > 0.6
- Only recommend SELL if the coin has negative news AND is over 5% of portfolio
- Prefer HOLD over uncertain trades
- quantity should be in the base coin (e.g. BTC, ETH, SOL)
- Keep position sizes reasonable (max 100 USDT worth)`

  let articlesText = ''
  if (research.articles.length > 0) {
    articlesText = '\n\nExtracted Article Data:\n'
    for (const a of research.articles) {
      articlesText += `\n--- ${a.title} ---`
      articlesText += `\nRelevance: ${a.relevance_score}`
      articlesText += `\nSentiment: ${a.sentiment}`
      articlesText += `\nSummary: ${a.summary}`
      articlesText += `\nKey Points:\n${a.key_points.map((k: string) => `  - ${k}`).join('\n')}`
      if (a.metrics) {
        articlesText += `\nMetrics: ${JSON.stringify(a.metrics)}`
      }
      if (a.preliminary_signal) {
        articlesText += `\nPreliminary Signal: ${a.preliminary_signal}`
      }
      articlesText += '\n'
    }
  }

  const user = `Coin: ${coin}
Price: $${price}
24h Change: ${change24h}%
Volume: $${volume}
Portfolio Allocation: ${portfolioPercent.toFixed(1)}%
Aggregated Sentiment: ${research.aggregated_sentiment}
Top Headlines: ${research.top_headlines.join('. ')}${articlesText}

Respond with JSON only:
{ "action": "BUY"|"SELL"|"HOLD", "coin": "${coin}", "quantity": number, "reason": "string", "confidence": 0.0-1.0 }`

  return { system, user }
}
