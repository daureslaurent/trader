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

  try {
    const resp = await client.chat.completions.create({
      model: config.llama.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    })

    const content = resp.choices[0]?.message?.content
    if (!content) throw new LLMError('Empty LLM response')

    const parsed = JSON.parse(content) as Signal
    logger.info('Signal from LLM', { coin, action: parsed.action, confidence: parsed.confidence })
    return parsed
  } catch (err) {
    logger.error('LLM analysis failed', { coin, error: (err as Error).message })
    return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis error', confidence: 0 }
  }
}
