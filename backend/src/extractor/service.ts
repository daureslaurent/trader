import OpenAI from 'openai'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { ResearchResult } from '../researcher/index.js'
import { buildExtractionPrompt } from './prompts.js'
import { ExtractedResearch, ExtractedArticle } from './types.js'

const client = new OpenAI({
  baseURL: config.llama.baseURL,
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

  logger.debug('Extracting article data', {
    coin: result.coin,
    articleCount: result.articles.length,
  })

  try {
    const { system, user } = buildExtractionPrompt(result.coin, result.articles)

    const resp = await client.chat.completions.create({
      model: config.llama.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    })

    const content = resp.choices[0]?.message?.content || ''
    if (!content.trim()) {
      logger.warn('LLM returned empty extraction', { coin: result.coin })
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

    const parsed = JSON.parse(cleaned) as ExtractedArticle[]

    const articles = Array.isArray(parsed) ? parsed : []
    const filtered = articles.filter(a => a.relevance_score >= 0.3)

    logger.debug('Extraction results', {
      coin: result.coin,
      totalExtracted: articles.length,
      afterFilter: filtered.length,
    })

    return {
      coin: result.coin,
      articles: filtered,
      aggregated_sentiment: computeAggregatedSentiment(filtered),
      top_headlines: result.headlines,
    }
  } catch (err) {
    logger.error('Article extraction failed', {
      coin: result.coin,
      error: (err as Error).message,
    })
    return {
      coin: result.coin,
      articles: [],
      aggregated_sentiment: 'neutral',
      top_headlines: result.headlines,
    }
  }
}
