import { ArticleContent } from '../researcher/index.js'
import { config } from '../config/index.js'

// Generic, query-relevant extraction prompt. Unlike the coin extractor (sentiment +
// preliminary BUY/SELL/HOLD signal), this is topic-agnostic: it pulls the information in
// the page that answers the caller's free-text query and scores how relevant the page is.
export function buildWebExtractPrompt(
  query: string,
  article: ArticleContent,
): { system: string; user: string } {
  const system = `You are a research assistant. Given a user's search query and the text of one web page, extract the information in the page that is relevant to the query.

Return a JSON object with a single key "article" containing an object with these fields:
- summary: a 1-2 sentence summary of what this page says that is relevant to the query
- key_points: array of 2-4 concrete facts or claims from the page that bear on the query — prefer numbers, dates, and named entities over vague statements
- relevance_score: 0.0-1.0, how relevant this page actually is to the query (0 = off-topic / unrelated, 1 = directly and substantially answers it)

Guidelines:
- Base everything on the page's actual content, not the query's assumptions. Do not invent facts.
- If the page is off-topic, spam/SEO filler, a login/paywall stub, or only mentions the topic in passing, give it a low relevance_score (≤ 0.2) and a brief summary saying so.`

  const content = article.content.length > config.webSearch.maxArticleChars
    ? article.content.slice(0, config.webSearch.maxArticleChars) + '…'
    : article.content

  const user = `Query: ${query}

Title: ${article.title}
URL: ${article.url}
Content:
${content}

Return { "article": { ... } }.`

  return { system, user }
}
