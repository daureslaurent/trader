import OpenAI from 'openai'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { ResearchResult } from '../researcher/index.js'
import { buildExtractionPrompt } from './prompts.js'
import { ExtractedResearch, ExtractedArticle } from './types.js'

const client = new OpenAI({
  baseURL: config.extractor.baseURL,
  apiKey: 'ollama',
})

function computeAggregatedSentiment(
  articles: ExtractedArticle[],
): 'positive' | 'negative' | 'neutral' {
  if (articles.length === 0) return 'neutral'
  const counts = { positive: 0, negative: 0, neutral: 0 }
  for (const a of articles) {
    counts[a.sentiment]++
  }
  if (counts.positive > counts.negative && counts.positive > counts.neutral) return 'positive'
  if (counts.negative > counts.positive && counts.negative > counts.neutral) return 'negative'
  return 'neutral'
}

export async function extractResearch(
  result: ResearchResult,
): Promise<ExtractedResearch> {
  if (result.articles.length === 0) {
    logger.debug('No articles to extract', { coin: result.coin })
    return {
      coin: result.coin,
      articles: [],
      aggregated_sentiment: 'neutral',
      top_headlines: result.headlines,
    }
  }

  logger.info('Starting extraction', {
    coin: result.coin,
    articleCount: result.articles.length,
    articles: result.articles.map(a => ({ title: a.title, url: a.url })),
  })

  try {
    const { system, user } = buildExtractionPrompt(result.coin, result.articles)

    logger.info('📞 Request LLM', { module: 'extractor', coin: result.coin, system, user })

    const resp = await client.chat.completions.create({
      model: config.extractor.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: config.extractor.maxTokens,
    })

    const content = resp.choices[0]?.message?.content || ''
    const finishReason = resp.choices[0]?.finish_reason

    logger.info('📣 Response LLM', { module: 'extractor', coin: result.coin, raw: content, finish_reason: finishReason })

    if (!content.trim()) {
      logger.warn('LLM returned empty extraction', { coin: result.coin, finish_reason: finishReason })
      return {
        coin: result.coin,
        articles: [],
        aggregated_sentiment: 'neutral',
        top_headlines: result.headlines,
      }
    }

    const cleaned = content
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/```\s*$/g, '')
      .trim()

    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      logger.warn('Extraction JSON parse failed', {
        coin: result.coin,
        rawPreview: cleaned.substring(0, 1000),
      })
      throw new Error('Failed to parse LLM extraction JSON')
    }

    const articles = Array.isArray(parsed) ? (parsed as ExtractedArticle[]) : []
    const filtered = articles.filter(a => a.relevance_score >= 0.3)

    const aggregated = computeAggregatedSentiment(filtered)

    logger.info('Extraction results', {
      coin: result.coin,
      totalExtracted: articles.length,
      afterFilter: filtered.length,
      aggregatedSentiment: aggregated,
      articles: filtered.map(a => ({
        title: a.title,
        relevance: a.relevance_score,
        sentiment: a.sentiment,
        signal: a.preliminary_signal,
      })),
    })

    return {
      coin: result.coin,
      articles: filtered,
      aggregated_sentiment: aggregated,
      top_headlines: result.headlines,
    }
  } catch (err) {
    const errObj = err as any
    logger.error('Article extraction failed', {
      coin: result.coin,
      message: errObj.message,
      stack: errObj.stack,
      status: errObj.status,
      statusText: errObj.statusText,
      cause: errObj.cause ? (errObj.cause as any)?.message || errObj.cause : undefined,
      baseURL: config.extractor.baseURL,
      model: config.extractor.model,
    })
    return {
      coin: result.coin,
      articles: [],
      aggregated_sentiment: 'neutral',
      top_headlines: result.headlines,
    }
  }
}
