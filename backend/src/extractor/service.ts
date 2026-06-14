import OpenAI from 'openai'
import { logger } from '../core/logger.js'
import { llmChat } from '../core/llm.js'
import type { LLMTarget } from '../core/llm.js'
import { resolveLLM } from '../config/llm.js'
import { extractionCache, getSettings, nowSql } from '../db/index.js'
import { ResearchResult, ArticleContent } from '../researcher/index.js'
import { buildChallengePrompt, buildSingleArticlePrompt, buildSelectionPrompt } from './prompts.js'
import { ExtractedResearch, ExtractedArticle, ArticleSkipReason } from './types.js'

export interface ExtractorLLMConfig {
  client: OpenAI
  model: string
  maxTokens: number
  baseURL: string
  /** Optional failover target, passed through to `llmChat`. */
  fallback?: LLMTarget
}

// Resolved fresh per call so per-module Settings overrides apply without a restart.
function getDefaultExtractorConfig(): ExtractorLLMConfig {
  const { client, model, maxTokens, baseURL, fallback } = resolveLLM('extractor')
  return { client, model, maxTokens, baseURL, fallback }
}

// ── Blocked-content detection ────────────────────────────────────────────────

const CLOUDFLARE_PATTERNS = [
  /cloudflare/i,
  /ray id:/i,
  /checking your browser/i,
  /enable javascript and cookies/i,
  /cf-ray/i,
]

const CAPTCHA_PATTERNS = [
  /captcha/i,
  /verify you are (a )?human/i,
  /i am not a robot/i,
  /complete the security check/i,
  /access denied/i,
  /403 forbidden/i,
  /ddos protection/i,
  /just a moment\.\.\./i,
]

function detectBlockedContent(content: string): ArticleSkipReason | null {
  if (CLOUDFLARE_PATTERNS.some(p => p.test(content))) return 'cloudflare'
  if (CAPTCHA_PATTERNS.some(p => p.test(content))) return 'captcha'
  return null
}

function makeSkippedArticle(
  article: { title: string; url: string },
  skip_reason: ArticleSkipReason,
): ExtractedArticle {
  return {
    title: article.title,
    url: article.url,
    relevance_score: 0,
    sentiment: 'neutral',
    summary: '',
    key_points: [],
    skip_reason,
  }
}

// ── Cache helpers ────────────────────────────────────────────────────────────

async function getCached(url: string): Promise<ExtractedArticle | null> {
  const ttl = getSettings().cache_ttl_hours || 13
  // Fresh = cached within the TTL window; compare the stored 'YYYY-MM-DD HH:MM:SS'
  // string against the cutoff (lexical order matches chronological order here).
  const cutoff = new Date(Date.now() - ttl * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
  const row = (await extractionCache.findOne(
    { _id: url, cached_at: { $gt: cutoff } },
    { projection: { data: 1 } },
  )) as { data: string } | null
  if (!row) return null
  try {
    return JSON.parse(row.data) as ExtractedArticle
  } catch {
    return null
  }
}

async function setCached(coin: string, url: string, article: ExtractedArticle): Promise<void> {
  const { from_cache: _, ...toStore } = article
  await extractionCache.upsert(url, { coin, data: JSON.stringify(toStore), cached_at: nowSql() })
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseSingleArticle(content: string): ExtractedArticle | null {
  try {
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
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

// ── Relevance challenge (cheap LLM call before full extraction) ──────────────

async function challengeArticle(
  coin: string,
  article: ArticleContent,
  llm: ExtractorLLMConfig,
): Promise<{ relevant: true } | { relevant: false; reason: string }> {
  // Use only the base symbol, not the trading pair (e.g. BTC/USDC → BTC)
  const baseCoin = coin.split('/')[0]
  const { system, user } = buildChallengePrompt(baseCoin, article)
  try {
    const resp = await llmChat(llm.client, {
      model: llm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.0,
      max_tokens: llm.maxTokens,
      response_format: { type: 'json_object' },
    }, { module: 'extractor-challenge', coin: baseCoin, base_url: llm.baseURL }, llm.fallback)

    const raw = resp.choices[0]?.message?.content ?? ''
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    logger.debug('Challenge response', { coin: baseCoin, url: article.url, raw: stripped })
    const parsed = JSON.parse(stripped) as { relevant?: boolean; reason?: string }
    if (parsed.relevant === true) {
      logger.info('Article challenge passed', { coin: baseCoin, url: article.url })
      return { relevant: true }
    }
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : 'Not relevant to this coin'
    logger.info('Article challenge failed', { coin: baseCoin, url: article.url, reason })
    return { relevant: false, reason }
  } catch (err) {
    logger.warn('Challenge error, allowing article through', {
      coin: baseCoin,
      url: article.url,
      error: (err as Error).message,
    })
    return { relevant: true }
  }
}

// ── Per-article extraction (1 LLM call, cached by URL) ──────────────────────

async function extractSingleArticle(
  coin: string,
  article: ArticleContent,
  llm: ExtractorLLMConfig,
): Promise<ExtractedArticle | null> {
  const cached = await getCached(article.url)
  if (cached) {
    logger.debug('Article cache hit', { coin, url: article.url })
    return { ...cached, from_cache: true }
  }

  const blocked = detectBlockedContent(article.content)
  if (blocked) {
    logger.info('Article blocked, skipping LLM', { coin, url: article.url, skip_reason: blocked })
    const skipped = makeSkippedArticle(article, blocked)
    await setCached(coin, article.url, skipped)
    return skipped
  }

  const challenge = await challengeArticle(coin, article, llm)
  if (!challenge.relevant) {
    const skipped = { ...makeSkippedArticle(article, 'irrelevant'), summary: challenge.reason }
    await setCached(coin, article.url, skipped)
    return skipped
  }

  const { system, user } = buildSingleArticlePrompt(coin, article)

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const resp = await llmChat(llm.client, {
        model: llm.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: llm.maxTokens,
        response_format: { type: 'json_object' },
      }, { module: 'extractor', coin, base_url: llm.baseURL }, llm.fallback)

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

      await setCached(coin, article.url, extracted)
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
  llm?: ExtractorLLMConfig,
): Promise<ExtractedResearch> {
  if (result.articles.length === 0) {
    logger.debug('No articles to extract', { coin: result.coin })
    return { coin: result.coin, articles: [], skipped_articles: [], aggregated_sentiment: 'neutral', top_headlines: result.headlines }
  }

  logger.info('Starting per-article extraction', {
    coin: result.coin,
    articleCount: result.articles.length,
  })

  const cfg = llm ?? getDefaultExtractorConfig()
  const settled = await Promise.allSettled(
    result.articles.map(a => extractSingleArticle(result.coin, a, cfg))
  )

  const articles: ExtractedArticle[] = []
  const skipped_articles: ExtractedArticle[] = []
  let cacheHits = 0

  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value) continue
    const article = r.value

    if (article.skip_reason) {
      skipped_articles.push(article)
      continue
    }

    if (article.relevance_score === 0) {
      skipped_articles.push({ ...article, skip_reason: 'irrelevant' })
      continue
    }

    articles.push(article)
    if (article.from_cache) cacheHits++
  }

  logger.info('Extraction complete', {
    coin: result.coin,
    valid: articles.length,
    fromCache: cacheHits,
    skipped: skipped_articles.length,
    skipBreakdown: skipped_articles.reduce<Record<string, number>>((acc, a) => {
      const r = a.skip_reason ?? 'unknown'
      acc[r] = (acc[r] ?? 0) + 1
      return acc
    }, {}),
  })

  return {
    coin: result.coin,
    articles,
    skipped_articles,
    aggregated_sentiment: computeAggregatedSentiment(articles),
    top_headlines: result.headlines,
  }
}

// ── selectArticles: LLM picks the pertinent subset ──────────────────────────

export async function selectArticles(
  coin: string,
  articles: ExtractedArticle[],
  llm?: ExtractorLLMConfig,
): Promise<ExtractedArticle[]> {
  if (articles.length === 0) return []
  if (articles.length <= 2) return articles

  const { system, user } = buildSelectionPrompt(coin, articles)
  const cfg = llm ?? getDefaultExtractorConfig()

  try {
    const resp = await llmChat(cfg.client, {
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      // Selection only needs a tiny JSON, but reasoning models spend tokens on a
      // hidden reasoning_content trace first — a fixed 256 budget gets fully
      // consumed by reasoning, leaving empty content (finish_reason: length). Use
      // the module's configured budget (with a small floor) so the model has room
      // to think *and* emit the JSON.
      max_tokens: Math.max(cfg.maxTokens, 512),
      response_format: { type: 'json_object' },
    }, { module: 'extractor', coin, base_url: cfg.baseURL }, cfg.fallback)

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
