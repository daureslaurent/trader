import OpenAI from 'openai'
import { logger } from '../core/logger.js'
import { llmChat } from '../core/llm.js'
import { resolveLLM } from '../config/llm.js'
import { Signal, MarketContext, PortfolioState } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'
import { buildAnalysisPrompt } from '../portfolio/prompts.js'
import { getCoinPortfolioContext } from '../portfolio/service.js'
import { classifyRegime } from '../portfolio/market.js'
import { computeRiskLevels } from '../portfolio/risk.js'
import { getSettings } from '../db/index.js'
import { LLMError } from '../core/errors.js'
import { fetchOrderBook, analyzeOrderBook } from '../trader/index.js'
import { OrderBookAnalysis } from '../trader/types.js'
import { getOHLCV, isTimeframe, Candle } from '../market/index.js'

const CONFIDENCE_MAP: Record<string, number> = {
  HIGH: 0.9,
  MEDIUM: 0.6,
  LOW: 0.3,
}

// The decision LLM now returns only direction + confidence + reason.
// SL/TP are computed deterministically (computeRiskLevels), so they are no
// longer parsed from the model output.
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

  // The LLM's horizon pick (only present in 'llm' mode). Sanitised here; the
  // caller decides whether to honour it, override it, or ignore it.
  const rawHorizon = String(parsed.horizon ?? '').toLowerCase()
  const horizon = (['short', 'medium', 'long'] as const).find(h => h === rawHorizon)

  return { coin, action: action as 'BUY' | 'SELL' | 'HOLD', quantity: 0, reason, confidence, horizon }
}

/**
 * Resolve the horizon for a new position from the configured mode and the LLM's pick.
 *  - 'auto'              → no horizon thesis; SL/TP sized off ATR.
 *  - 'llm'               → honour the model's pick (fallback to 'medium' if it omitted one).
 *  - 'short'|'medium'|'long' → force this horizon, overriding the model.
 * `positionHorizon` is stamped on the position; `riskHorizon` is what computeRiskLevels uses.
 */
function resolveHorizon(
  mode: 'auto' | 'llm' | 'short' | 'medium' | 'long',
  llmPick: 'short' | 'medium' | 'long' | undefined,
): { positionHorizon: 'short' | 'medium' | 'long' | undefined; riskHorizon: 'auto' | 'short' | 'medium' | 'long' } {
  if (mode === 'auto') return { positionHorizon: undefined, riskHorizon: 'auto' }
  const h = mode === 'llm' ? (llmPick ?? 'medium') : mode
  return { positionHorizon: h, riskHorizon: h }
}

export async function analyzeSignal(
  coin: string,
  market: MarketContext,
  portfolio: PortfolioState,
  research: ExtractedResearch,
): Promise<Signal> {
  const settings = getSettings()
  const coinCtx = await getCoinPortfolioContext(coin)

  // Deterministic regime — handed to the LLM as a fact, never asked of it (#1).
  const regime = classifyRegime(market)

  // Fetch live order book for liquidity context; non-fatal if it fails
  let orderBook: OrderBookAnalysis | null = null
  try {
    const book = await fetchOrderBook(coin, 20)
    orderBook = analyzeOrderBook(book, market.price > 0 ? 100 / market.price : 1)
  } catch (obErr) {
    logger.warn('Order book fetch failed, proceeding without it', { coin, error: (obErr as Error).message })
  }

  // Recent candles give the decision LLM the actual price structure behind the
  // summary indicators (swing highs/lows, extension, volume). Non-fatal on
  // failure and skippable via count 0 — the prompt simply omits the table.
  const tf = isTimeframe(settings.analyst_candle_tf) ? settings.analyst_candle_tf : '1h'
  const count = Math.min(100, settings.analyst_candle_count)
  let candles: Candle[] = []
  if (count >= 1) {
    try {
      candles = await getOHLCV(coin, tf, count)
    } catch (cErr) {
      logger.warn('Failed to fetch candle history for analyst prompt', { coin, tf, error: (cErr as Error).message })
    }
  }

  // In 'llm' mode the analyst chooses the trade horizon as part of its judgement;
  // any other mode resolves the horizon deterministically (see resolveHorizon below).
  const chooseHorizon = settings.default_horizon === 'llm'
  const { system, user } = buildAnalysisPrompt(coin, market, regime, portfolio, settings, research, coinCtx, orderBook, chooseHorizon, candles, tf)
  const llm = resolveLLM('analyst')
  logger.info('Request LLM', { module: 'analyst', coin, regime: regime.summary, model: llm.model })

  const params: OpenAI.ChatCompletionCreateParams = {
    model: llm.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // Single low temperature — the only subtask left is a discrete judgement (#1a)
    temperature: 0.2,
    max_tokens: llm.maxTokens,
    response_format: { type: 'json_object' },
  }

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const resp = await llmChat(llm.client, params, { module: 'analyst', coin, base_url: llm.baseURL }, llm.fallback)
      const content = resp.choices[0]?.message?.content ?? ''
      logger.info('Response LLM', { module: 'analyst', coin, finish_reason: resp.choices[0]?.finish_reason })
      const signal = parseAnalystResponse(content, coin)
      const { positionHorizon, riskHorizon } = resolveHorizon(settings.default_horizon, signal.horizon)
      signal.horizon = positionHorizon

      // Deterministic SL/TP for BUYs — computed from ATR / horizon / volatility,
      // not guessed by the LLM (#1b). The horizon thesis may come from the LLM,
      // but the % sizing off it stays mechanical. Carried as % on the signal; index.ts converts.
      if (signal.action === 'BUY') {
        const risk = computeRiskLevels(market, regime, riskHorizon, settings)
        signal.stop_loss_pct = risk.stopLossPct
        signal.take_profit_pct = risk.takeProfitPct
        logger.info('Risk levels (deterministic)', {
          coin, sl_pct: risk.stopLossPct, tp_pct: risk.takeProfitPct, source: risk.source, notes: risk.notes,
        })
      }

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
        baseURL: llm.baseURL, model: llm.model,
      })
      return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis error', confidence: 0, horizon: undefined }
    }
  }

  return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis failed after retry', confidence: 0, horizon: undefined }
}
