import { ArticleContent } from '../researcher/index.js'
import { ExtractedArticle } from './types.js'
import { config } from '../config/index.js'

export function buildChallengePrompt(
  coin: string,
  article: ArticleContent,
): { system: string; user: string } {
  const system = `You are a relevance filter for cryptocurrency research. Your only job is to decide whether an article is specifically about the given coin's price, market performance, fundamentals, or trading outlook.

Mark NOT relevant:
- Generic market roundups or "top N coins" listicles where the coin is only mentioned in passing
- Price-prediction clickbait with no factual basis ("could hit $X by 2030")
- Sponsored content, casino/presale promotions, or articles about a different coin with a similar name

Return ONLY a JSON object: { "relevant": true } or { "relevant": false }`

  const content = article.content.length > config.extractor.maxChallengeChars
    ? article.content.slice(0, config.extractor.maxChallengeChars) + '…'
    : article.content

  const user = `Coin: ${coin}

Title: ${article.title}
Content:
${content}

Is this article specifically about ${coin}? Return { "relevant": true } or { "relevant": false, "reason": "one sentence why not" }.`

  return { system, user }
}

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
- key_points: array of 2-3 concrete facts or claims from the article — prefer numbers, dates, and named entities over vague claims
- preliminary_signal: "BUY", "SELL", or "HOLD" — based solely on this article's content

Guidelines:
- Only flag BUY for concrete, fresh positive developments (partnerships, adoption, upgrades, strong fundamentals)
- Only flag SELL for concrete negative developments (hacks, regulatory actions, missed milestones)
- Default to HOLD for neutral, mixed, or speculative content
- Old news the market has already absorbed is HOLD even if positive — a tradable signal needs a NEW catalyst
- Judge sentiment from the facts reported, not the headline's hype. Price predictions and influencer opinions are not catalysts; score their relevance ≤ 0.3`

  const content = article.content.length > config.extractor.maxArticleChars
    ? article.content.slice(0, config.extractor.maxArticleChars) + '…'
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
2. Concrete, dated facts over speculation, opinion, or price predictions
3. Actionable signals (BUY or SELL preferred over HOLD)
4. Source diversity — avoid selecting multiple articles on the same event; keep the most factual one

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
