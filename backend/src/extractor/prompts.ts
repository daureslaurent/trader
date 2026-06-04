import { ArticleContent } from '../researcher/index.js'

export function buildExtractionPrompt(
  coin: string,
  articles: ArticleContent[],
): { system: string; user: string } {
  const system = `You are a crypto research analyst. Extract structured data from cryptocurrency news articles.

For each article, return a JSON array of objects with these fields:
- title: the article title
- url: the article URL
- relevance_score: 0.0-1.0 how relevant to the coin's price/market outlook
- sentiment: "positive", "negative", or "neutral" — overall tone toward the coin
- summary: 2-3 sentence summary of key information
- key_points: array of 3-5 concrete facts or claims from the article
- preliminary_signal: "BUY", "SELL", or "HOLD" — based solely on this article's content

Guidelines:
- Recent articles likely matter more — weight breaking news over general market commentary
- Prefer established sources (CoinDesk, Bloomberg, Reuters, official announcements) over speculation or social media
- If multiple articles cover the same event, keep the most authoritative version and skip duplicates
- Only flag BUY if the news describes concrete positive developments (partnerships, adoption, upgrades, strong fundamentals)
- Only flag SELL if the news contains concrete negative developments (hacks, regulatory actions, missed milestones)
- Default to HOLD for neutral, mixed, or purely speculative articles
- If no articles contain actionable information, return an empty array []`

  let articlesText = ''
  for (const a of articles) {
    articlesText += `\n\n### ${a.title}\nURL: ${a.url}\nContent:\n${a.content}\n`
  }

  const user = `Coin: ${coin}\n\nArticles:${articlesText}\n\nReturn a JSON array of extracted articles.`

  return { system, user }
}
