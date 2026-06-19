import OpenAI from 'openai'
import { createHash } from 'node:crypto'
import { logger } from '../core/logger.js'
import type { LLMTarget } from '../core/llm.js'
import { scheduleChat } from '../core/llmScheduler.js'
import { resolveLLM } from '../config/llm.js'
import { extractionCache, getSettings, nowSql } from '../db/index.js'
import type { ArticleContent } from '../researcher/index.js'
import { buildWebExtractPrompt } from './prompts.js'
import type { WebArticle, WebArticleSkipReason } from './types.js'

export interface WebExtractLLMConfig {
  client: OpenAI
  model: string
  maxTokens: number
  baseURL: string
  fallback?: LLMTarget
}

// Resolved fresh per call so per-module Settings overrides apply without a restart.
function getDefaultConfig(): WebExtractLLMConfig {
  const { client, model, maxTokens, baseURL, fallback } = resolveLLM('webSearch')
  return { client, model, maxTokens, baseURL, fallback }
}

// ── Blocked-content detection (mirrors extractor/service.ts) ──────────────────

const CLOUDFLARE_PATTERNS = [/cloudflare/i, /ray id:/i, /checking your browser/i, /enable javascript and cookies/i, /cf-ray/i]
const CAPTCHA_PATTERNS = [/captcha/i, /verify you are (a )?human/i, /i am not a robot/i, /complete the security check/i, /access denied/i, /403 forbidden/i, /ddos protection/i, /just a moment\.\.\./i]

function detectBlockedContent(content: string): WebArticleSkipReason | null {
  if (CLOUDFLARE_PATTERNS.some(p => p.test(content))) return 'cloudflare'
  if (CAPTCHA_PATTERNS.some(p => p.test(content))) return 'captcha'
  return null
}

function makeSkipped(article: ArticleContent, skip_reason: WebArticleSkipReason, summary = ''): WebArticle {
  return { title: article.title, url: article.url, relevance_score: 0, summary, key_points: [], skip_reason }
}

// ── Query-scoped cache (shares the extraction_cache collection) ───────────────
// Keyed by query + URL so the same page extracted under different queries doesn't
// collide with itself — or with the coin pipeline's URL-keyed entries.
function cacheKey(query: string, url: string): string {
  const qh = createHash('sha1').update(query.trim().toLowerCase()).digest('hex').slice(0, 12)
  return `ws:${qh}:${url}`
}

async function getCached(query: string, url: string): Promise<WebArticle | null> {
  const ttl = getSettings().cache_ttl_hours || 13
  const cutoff = new Date(Date.now() - ttl * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
  const row = (await extractionCache.findOne(
    { _id: cacheKey(query, url), cached_at: { $gt: cutoff } },
    { projection: { data: 1 } },
  )) as { data: string } | null
  if (!row) return null
  try { return JSON.parse(row.data) as WebArticle } catch { return null }
}

async function setCached(query: string, article: WebArticle): Promise<void> {
  const { from_cache: _, ...toStore } = article
  // `coin: 'WEB'` is a pseudo-bucket so these query-scoped rows group together (and stay
  // inspectable) on the coin-centric Cache view instead of falling into a null bucket.
  await extractionCache.upsert(cacheKey(query, article.url), {
    coin: 'WEB', query, data: JSON.stringify(toStore), cached_at: nowSql(),
  })
}

function parse(content: string): { summary: string; key_points: string[]; relevance_score: number } | null {
  try {
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const parsed = JSON.parse(stripped) as Record<string, unknown>
    const raw = (parsed.article ?? parsed) as Record<string, unknown>
    if (typeof raw !== 'object' || !raw) return null
    if (typeof raw.relevance_score !== 'number') return null
    return {
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      key_points: Array.isArray(raw.key_points) ? raw.key_points.map(String) : [],
      relevance_score: raw.relevance_score,
    }
  } catch {
    return null
  }
}

// ── Per-article extraction (1 LLM call, cached by query+URL) ──────────────────

async function extractOne(query: string, article: ArticleContent, llm: WebExtractLLMConfig): Promise<WebArticle | null> {
  const cached = await getCached(query, article.url)
  if (cached) return { ...cached, from_cache: true }

  const blocked = detectBlockedContent(article.content)
  if (blocked) {
    const skipped = makeSkipped(article, blocked)
    await setCached(query, skipped)
    return skipped
  }

  const { system, user } = buildWebExtractPrompt(query, article)

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const resp = await scheduleChat({
        module: 'webSearch', lane: 'parallel',
        route: () => ({ client: llm.client, model: llm.model, baseURL: llm.baseURL, maxTokens: llm.maxTokens, fallback: llm.fallback }),
        build: async (route) => ({
          model: route.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.2,
          max_tokens: route.maxTokens,
          response_format: { type: 'json_object' },
        }),
      })

      if (resp.choices[0]?.finish_reason === 'length') {
        logger.warn('web extract hit token limit', { url: article.url })
        return null
      }
      const parsed = parse(resp.choices[0]?.message?.content ?? '')
      if (!parsed) {
        if (attempt === 0) { logger.warn('web extract parse failed, retrying', { url: article.url }); continue }
        return null
      }
      const extracted: WebArticle = {
        title: article.title, url: article.url,
        relevance_score: parsed.relevance_score, summary: parsed.summary, key_points: parsed.key_points,
      }
      await setCached(query, extracted)
      return extracted
    } catch (err) {
      if (attempt === 0) { logger.warn('web extract error, retrying', { url: article.url, error: (err as Error).message }); continue }
      logger.error('web extract failed', { url: article.url, error: (err as Error).message })
      return null
    }
  }
  return null
}

// Extract every fetched page in parallel against the query, dropping blocked/irrelevant
// pages. Returns only usable articles (relevance_score > 0), sorted most-relevant first.
export async function extractForQuery(
  query: string,
  articles: ArticleContent[],
  llm?: WebExtractLLMConfig,
): Promise<WebArticle[]> {
  if (articles.length === 0) return []
  const cfg = llm ?? getDefaultConfig()

  const settled = await Promise.allSettled(articles.map(a => extractOne(query, a, cfg)))
  const out: WebArticle[] = []
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value) continue
    const a = r.value
    if (a.skip_reason || a.relevance_score <= 0) continue
    out.push(a)
  }
  out.sort((a, b) => b.relevance_score - a.relevance_score)
  logger.info('web extraction complete', { query, fetched: articles.length, relevant: out.length })
  return out
}
