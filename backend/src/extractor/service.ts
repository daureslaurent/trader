import OpenAI from 'openai'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { queryOne, runSQL } from '../db/index.js'
import { ResearchResult, ArticleContent } from '../researcher/index.js'
import { buildSingleArticlePrompt, buildSelectionPrompt } from './prompts.js'
import { ExtractedResearch, ExtractedArticle } from './types.js'

const client = new OpenAI({
  baseURL: config.extractor.baseURL,
  apiKey: 'ollama',
})

// ── Cache helpers ────────────────────────────────────────────────────────────

function getCacheTtlHours(): number {
  const row = queryOne("SELECT value FROM settings WHERE key = 'cache_ttl_hours'") as { value: string } | null
  return row ? (parseInt(row.value, 10) || 13) : 13
}

function getCached(url: string): ExtractedArticle | null {
  const ttl = getCacheTtlHours()
  const row = queryOne(
    `SELECT data FROM extraction_cache WHERE url = ? AND datetime(cached_at, '+${ttl} hours') > datetime('now')`,
    [url]
  ) as { data: string } | null
  if (!row) return null
  try {
    return JSON.parse(row.data) as ExtractedArticle
  } catch {
    return null
  }
}

function setCached(coin: string, url: string, article: ExtractedArticle): void {
  const { from_cache: _, ...toStore } = article
  runSQL(
    "INSERT OR REPLACE INTO extraction_cache (url, coin, data, cached_at) VALUES (?, ?, ?, datetime('now'))",
    [url, coin, JSON.stringify(toStore)]
  )
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseSingleArticle(content: string): ExtractedArticle | null {
  try {
    const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const parsed = JSON.parse(stripped)
    const raw: unknown = (parsed as any)?.article ?? parsed
    if (typeof raw !== 'object' || !raw) return null
    const a = raw as ExtractedArticle
    if (typeof a.relevance_score !== 'number') return null
    if (!['positive', 'negative', 'neutral'].includes(a.sentiment)) return null
    return a
  } catch {
    return null
  }
}

function computeAggregatedSentiment(
  articles: ExtractedArticle[],
): 'positive' | 'negative' | 'neutral' {
  if (articles.length === 0) return 'neutral'
  const counts = { positive: 0, negative: 0, neutral: 0 }
  for (const a of articles) counts[a.sentiment]++
  if (counts.positive > counts.negative && counts.positive > counts.neutral) return 'positive'
  if (counts.negative > counts.positive && counts.negative > counts.neutral) return 'negative'
  return 'neutral'
}

// ── Per-article extraction (1 LLM call, cached by URL) ──────────────────────

async function extractSingleArticle(
  coin: string,
  article: ArticleContent,
): Promise<ExtractedArticle | null> {
  const cached = getCached(article.url)
  if (cached) {
    logger.debug('Article cache hit', { coin, url: article.url })
    return { ...cached, from_cache: true }
  }

  const { system, user } = buildSingleArticlePrompt(coin, article)

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model: config.extractor.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: config.extractor.maxTokens,
        response_format: { type: 'json_object' },
      })

      const content = resp.choices[0]?.message?.content ?? ''
      if (resp.choices[0]?.finish_reason === 'length') {
        logger.warn('Extractor hit token limit for article', { coin, url: article.url })
        return null
      }

      const extracted = parseSingleArticle(content)
      if (!extracted) {
        if (attempt === 0) { logger.warn('Parse failed, retrying', { coin, url: article.url }); continue }
        return null
      }

      setCached(coin, article.url, extracted)
      return extracted
    } catch (err) {
      if (attempt === 0) {
        logger.warn('Article extraction error, retrying', { coin, url: article.url, error: (err as Error).message })
        continue
      }
      logger.error('Article extraction failed', { coin, url: article.url, error: (err as any).message })
      return null
    }
  }
  return null
}

// ── extractResearch: parallel per-article extraction ────────────────────────

export async function extractResearch(
  result: ResearchResult,
): Promise<ExtractedResearch> {
  if (result.articles.length === 0) {
    logger.debug('No articles to extract', { coin: result.coin })
    return { coin: result.coin, articles: [], aggregated_sentiment: 'neutral', top_headlines: result.headlines }
  }

  logger.info('Starting per-article extraction', {
    coin: result.coin,
    articleCount: result.articles.length,
  })

  const settled = await Promise.allSettled(
    result.articles.map(a => extractSingleArticle(result.coin, a))
  )

  const articles: ExtractedArticle[] = []
  let cacheHits = 0
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) {
      articles.push(r.value)
      if (r.value.from_cache) cacheHits++
    }
  }

  logger.info('Extraction complete', {
    coin: result.coin,
    total: articles.length,
    fromCache: cacheHits,
    fresh: articles.length - cacheHits,
  })

  return {
    coin: result.coin,
    articles,
    aggregated_sentiment: computeAggregatedSentiment(articles),
    top_headlines: result.headlines,
  }
}

// ── selectArticles: LLM picks the pertinent subset ──────────────────────────

export async function selectArticles(
  coin: string,
  articles: ExtractedArticle[],
): Promise<ExtractedArticle[]> {
  if (articles.length === 0) return []
  if (articles.length <= 2) return articles

  const { system, user } = buildSelectionPrompt(coin, articles)

  try {
    const resp = await client.chat.completions.create({
      model: config.extractor.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    })

    const content = resp.choices[0]?.message?.content ?? ''
    const parsed = JSON.parse(content) as { selected_urls?: string[] }
    const selectedUrls = new Set(parsed.selected_urls ?? [])

    if (selectedUrls.size === 0) {
      logger.info('Selector returned empty set, keeping all articles', { coin })
      return articles
    }

    const selected = articles.filter(a => selectedUrls.has(a.url))
    if (selected.length === 0) {
      logger.warn('Selector URLs matched nothing, keeping all articles', { coin })
      return articles
    }

    logger.info('Article selection complete', {
      coin,
      total: articles.length,
      selected: selected.length,
    })
    return selected
  } catch (err) {
    logger.warn('Article selection failed, keeping all articles', { coin, error: (err as Error).message })
    return articles
  }
}
