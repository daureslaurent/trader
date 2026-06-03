import OpenAI from 'openai'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { Signal } from '../types.js'
import { ResearchResult } from '../researcher/index.js'
import { buildAnalysisPrompt } from './prompts.js'
import { LLMError } from '../core/errors.js'

const client = new OpenAI({
  baseURL: config.llama.baseURL,
  apiKey: 'ollama',
})

export async function analyzeSignal(
  coin: string,
  price: number,
  change24h: number,
  volume: number,
  research: ResearchResult,
  portfolioPercent: number,
): Promise<Signal> {
  const { system, user } = buildAnalysisPrompt(coin, price, change24h, volume, research, portfolioPercent)
  logger.info('LLM input', { coin, system, user })

  try {
    const resp = await client.chat.completions.create({
      model: config.llama.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 28000,
    })

    const content = resp.choices[0]?.message?.content || ''
    logger.info('LLM output', { coin, content, finish_reason: resp.choices[0]?.finish_reason })
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
    return parsed
  } catch (err) {
    logger.error('LLM analysis failed', { coin, error: (err as Error).message })
    return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis error', confidence: 0 }
  }
}
