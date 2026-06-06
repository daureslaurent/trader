import { ArticleContent } from '../researcher/index.js'
import { ExtractedArticle } from './types.js'

const MAX_ARTICLE_CHARS = 1200

export function buildSingleArticlePrompt(
  coin: string,
  article: ArticleContent,
): { system: string; user: string } {
  const system = `You are a crypto research analyst. Extract structured data from a single cryptocurrency news article.

Return a JSON object with a single key "article" containing an object with these fields:
- title: the article title
- url: the article URL
- relevance_score: 0.0-1.0 how relevant to this coin's price/market outlook
- sentiment: "positive", "negative", or "neutral" — overall tone toward the coin
- summary: 1-2 sentence summary of key information
- key_points: array of 2-3 concrete facts or claims from the article
- preliminary_signal: "BUY", "SELL", or "HOLD" — based solely on this article's content

Guidelines:
- Only flag BUY for concrete positive developments (partnerships, adoption, upgrades, strong fundamentals)
- Only flag SELL for concrete negative developments (hacks, regulatory actions, missed milestones)
- Default to HOLD for neutral, mixed, or speculative content`

  const content = article.content.length > MAX_ARTICLE_CHARS
    ? article.content.slice(0, MAX_ARTICLE_CHARS) + '…'
    : article.content

  const user = `Coin: ${coin}

Title: ${article.title}
URL: ${article.url}
Content:
${content}

Return { "article": { ... } }.`

  return { system, user }
}

export function buildSelectionPrompt(
  coin: string,
  articles: ExtractedArticle[],
): { system: string; user: string } {
  const system = `You are a crypto research filter. Select the most pertinent articles for making a trading decision on ${coin}.

Return ONLY a JSON object: { "selected_urls": ["url1", "url2", ...] }

Selection criteria (in priority order):
1. High relevance to the coin's price or market outlook (relevance_score >= 0.4)
2. Actionable signals (BUY or SELL preferred over HOLD)
3. Concrete facts over speculation or opinion
4. Source diversity — avoid selecting multiple articles on the same event

Keep at most 5 articles. If fewer articles are provided, you may keep all.
If none are relevant enough, return { "selected_urls": [] }.`

  const articlesText = articles.map((a, i) =>
    `${i + 1}. URL: ${a.url}\n   Title: ${a.title}\n   Relevance: ${a.relevance_score.toFixed(2)} | Sentiment: ${a.sentiment} | Signal: ${a.preliminary_signal ?? 'HOLD'}\n   Summary: ${a.summary}`
  ).join('\n\n')

  const user = `Coin: ${coin}

Articles to evaluate:
${articlesText}

Select the most pertinent URLs for trading analysis. Return { "selected_urls": [...] }.`

  return { system, user }
}
