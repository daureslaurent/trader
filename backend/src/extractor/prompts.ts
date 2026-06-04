import { ArticleContent } from '../researcher/index.js'

export function buildExtractionPrompt(
  coin: string,
  articles: ArticleContent[],
): { system: string; user: string } {
  const system = `You are a crypto research analyst. Extract structured data from cryptocurrency news articles.

For each article, analyze the content and return a JSON array of objects with these fields:
- title: the article title
- url: the article URL
- relevance_score: 0.0-1.0 how relevant this article is to the coin's price/market outlook
- sentiment: "positive", "negative", or "neutral" — the article's overall tone toward the coin
- summary: 2-3 sentence concise summary of key information
- key_points: array of 3-5 specific bullet points with concrete facts/claims
- metrics: object with fields (use null when not mentioned):
  - price_target: { min: number | null, max: number | null } or null
  - market_cap: number or null
  - circulating_supply: number or null
  - volume_trend: "increasing" | "decreasing" | "stable" | null
- preliminary_signal: "BUY", "SELL", or "HOLD" — based solely on this article's content

Be conservative:
- If data is not clearly present in the article, use null
- Only flag BUY if the news is directly positive about the coin's fundamentals
- Only flag SELL if the news contains concrete negative developments
- Default to HOLD for neutral or mixed articles`

  let articlesText = ''
  for (const a of articles) {
    articlesText += `\n\n### ${a.title}\nURL: ${a.url}\nContent:\n${a.content}\n`
  }

  const user = `Coin: ${coin}\n\nArticles:${articlesText}\n\nReturn a JSON array of extracted articles. Example format:
[
  {
    "title": "Article title",
    "url": "https://...",
    "relevance_score": 0.85,
    "sentiment": "positive",
    "summary": "2-3 sentence summary",
    "key_points": ["Point 1", "Point 2", "Point 3"],
    "metrics": {
      "price_target": { "min": 50000, "max": 80000 },
      "market_cap": 1000000000,
      "circulating_supply": 19000000,
      "volume_trend": "increasing"
    },
    "preliminary_signal": "BUY"
  }
]`

  return { system, user }
}
