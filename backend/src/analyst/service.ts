import OpenAI from 'openai'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { Signal, MarketContext, PortfolioState } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'
import { buildAnalysisPrompt } from '../portfolio/prompts.js'
import { getCoinPortfolioContext } from '../portfolio/service.js'
import { getSettings } from '../db/index.js'
import { LLMError } from '../core/errors.js'

const client = new OpenAI({
  baseURL: config.analyst.baseURL,
  apiKey: 'ollama',
})

const CONFIDENCE_MAP: Record<string, number> = {
  HIGH: 0.9,
  MEDIUM: 0.6,
  LOW: 0.3,
}

function parseAnalystResponse(content: string, coin: string): Signal {
  if (!content.trim()) throw new LLMError('Empty response')

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    throw new LLMError(`JSON parse failed. Raw: ${content.substring(0, 200)}`)
  }

  const action = parsed.action as string
  if (!action || !['BUY', 'SELL', 'HOLD'].includes(action)) {
    throw new LLMError(`Invalid action "${action}". Raw: ${content.substring(0, 200)}`)
  }

  const rawConf = String(parsed.confidence ?? '').toUpperCase()
  const confidence = CONFIDENCE_MAP[rawConf] ?? CONFIDENCE_MAP.LOW
  if (!(rawConf in CONFIDENCE_MAP)) {
    logger.warn('Unrecognised confidence level, defaulting to LOW', { coin, rawConf })
  }

  const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
    ? parsed.reason.trim()
    : 'No reason provided'

  return { coin, action: action as 'BUY' | 'SELL' | 'HOLD', quantity: 0, reason, confidence }
}

export async function analyzeSignal(
  coin: string,
  market: MarketContext,
  portfolio: PortfolioState,
  research: ExtractedResearch,
): Promise<Signal> {
  const settings = getSettings()
  const coinCtx = getCoinPortfolioContext(coin)
  const { system, user } = buildAnalysisPrompt(coin, market, portfolio, settings, research, coinCtx)
  logger.info('Request LLM', { module: 'analyst', coin })

  const params: OpenAI.ChatCompletionCreateParams = {
    model: config.analyst.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    max_tokens: config.analyst.maxTokens,
    response_format: { type: 'json_object' },
  }

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const resp = await client.chat.completions.create(params)
      const content = resp.choices[0]?.message?.content ?? ''
      logger.info('Response LLM', { module: 'analyst', coin, finish_reason: resp.choices[0]?.finish_reason })
      const signal = parseAnalystResponse(content, coin)
      logger.info('Signal from LLM', { coin, action: signal.action, confidence: signal.confidence })
      return signal
    } catch (err) {
      if (attempt === 0 && err instanceof LLMError) {
        logger.warn('LLM analyst parse failed, retrying', { coin, error: err.message })
        continue
      }
      const e = err as any
      logger.error('LLM analysis failed', {
        coin, message: e.message, status: e.status,
        baseURL: config.analyst.baseURL, model: config.analyst.model,
      })
      return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis error', confidence: 0 }
    }
  }

  return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis failed after retry', confidence: 0 }
}
