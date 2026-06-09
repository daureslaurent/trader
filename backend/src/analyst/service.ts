import OpenAI from 'openai'
import { config } from '../config/index.js'
import { logger } from '../core/logger.js'
import { llmChat } from '../core/llm.js'
import { Signal, MarketContext, PortfolioState } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'
import { buildAnalysisPrompt } from '../portfolio/prompts.js'
import { getCoinPortfolioContext } from '../portfolio/service.js'
import { getSettings } from '../db/index.js'
import { LLMError } from '../core/errors.js'
import { fetchOrderBook, analyzeOrderBook } from '../trader/index.js'
import { OrderBookAnalysis } from '../trader/types.js'

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
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    parsed = JSON.parse(stripped) as Record<string, unknown>
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

  // LLM-decided SL/TP percentages (only meaningful for BUY; clamped to safe ranges)
  let stop_loss_pct: number | undefined
  let take_profit_pct: number | undefined
  if (action === 'BUY') {
    if (typeof parsed.stop_loss_pct === 'number' && parsed.stop_loss_pct > 0) {
      stop_loss_pct = Math.min(Math.max(parsed.stop_loss_pct, 0.5), 25)
    }
    if (typeof parsed.take_profit_pct === 'number' && parsed.take_profit_pct > 0) {
      take_profit_pct = Math.min(Math.max(parsed.take_profit_pct, 0.5), 50)
    }
    if (stop_loss_pct != null && take_profit_pct != null) {
      logger.info('LLM-decided SL/TP', { coin, stop_loss_pct, take_profit_pct })
    }
  }

  return { coin, action: action as 'BUY' | 'SELL' | 'HOLD', quantity: 0, reason, confidence, stop_loss_pct, take_profit_pct, horizon: undefined }
}

export async function analyzeSignal(
  coin: string,
  market: MarketContext,
  portfolio: PortfolioState,
  research: ExtractedResearch,
): Promise<Signal> {
  const settings = getSettings()
  const coinCtx = getCoinPortfolioContext(coin)

  // Fetch live order book for LLM context; non-fatal if it fails
  let orderBook: OrderBookAnalysis | null = null
  try {
    const book = await fetchOrderBook(coin, 20)
    orderBook = analyzeOrderBook(book, market.price > 0 ? 100 / market.price : 1)
  } catch (obErr) {
    logger.warn('Order book fetch failed, proceeding without it', { coin, error: (obErr as Error).message })
  }

  const { system, user } = buildAnalysisPrompt(coin, market, portfolio, settings, research, coinCtx, orderBook)
  // 'auto' means the LLM decides SL/TP freely — no specific horizon is stamped on the position
  const defaultHorizon = settings.default_horizon === 'auto' ? undefined : settings.default_horizon
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
      const resp = await llmChat(client, params, { module: 'analyst', coin })
      const content = resp.choices[0]?.message?.content ?? ''
      logger.info('Response LLM', { module: 'analyst', coin, finish_reason: resp.choices[0]?.finish_reason })
      const signal = parseAnalystResponse(content, coin)
      signal.horizon = defaultHorizon
      logger.info('Signal from LLM', { coin, action: signal.action, confidence: signal.confidence, horizon: signal.horizon })
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
      return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis error', confidence: 0, horizon: defaultHorizon }
    }
  }

  return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis failed after retry', confidence: 0, horizon: defaultHorizon }
}
