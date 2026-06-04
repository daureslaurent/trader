import OpenAI from 'openai'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { Signal, MarketContext, PortfolioState } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'
import { buildAnalysisPrompt } from '../portfolio/prompts.js'
import { getSettings } from '../db/index.js'
import { LLMError } from '../core/errors.js'

const client = new OpenAI({
  baseURL: config.analyst.baseURL,
  apiKey: 'ollama',
})

export async function analyzeSignal(
  coin: string,
  market: MarketContext,
  portfolio: PortfolioState,
  research: ExtractedResearch,
): Promise<Signal> {
  const settings = getSettings()
  const { system, user } = buildAnalysisPrompt(coin, market, portfolio, settings, research)
  logger.info('Request LLM', { module: 'analyst', coin })

  try {
    const resp = await client.chat.completions.create({
      model: config.analyst.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: config.analyst.maxTokens,
    })

    const content = resp.choices[0]?.message?.content || ''
    logger.info('Response LLM', { module: 'analyst', coin, finish_reason: resp.choices[0]?.finish_reason })

    if (!content.trim()) {
      const finish = resp.choices[0]?.finish_reason
      logger.warn('LLM empty response', { coin, finish_reason: finish })
      return { coin, action: 'HOLD', quantity: 0, reason: `LLM returned empty (${finish})`, confidence: 0 }
    }

    const cleaned = content
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/```\s*$/g, '')
      .trim()

    const parsed = JSON.parse(cleaned) as Signal
    if (!parsed.action || !['BUY', 'SELL', 'HOLD'].includes(parsed.action)) {
      throw new LLMError(`Invalid action: ${parsed.action}, raw: ${content.substring(0, 200)}`)
    }

    logger.info('Signal from LLM', { coin, action: parsed.action, confidence: parsed.confidence })
    return {
      coin,
      action: parsed.action,
      quantity: 0,
      reason: parsed.reason || '',
      confidence: parsed.confidence || 0,
    }
  } catch (err) {
    const e = err as any
    logger.error('LLM analysis failed', {
      coin, message: e.message, status: e.status,
      baseURL: config.analyst.baseURL, model: config.analyst.model,
    })
    return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis error', confidence: 0 }
  }
}
