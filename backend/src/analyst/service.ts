import OpenAI from 'openai'
import { logger } from '../core/logger.js'
import { resolveLLM } from '../config/llm.js'
import { scheduleChat } from '../core/llmScheduler.js'
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

// Legacy fallback: the analyst now returns a numeric confidence in [0, 1], but a
// local model may drift back to the old categorical words — map those if so.
const LEGACY_CONFIDENCE_MAP: Record<string, number> = {
  HIGH: 0.9,
  MEDIUM: 0.6,
  LOW: 0.3,
}

/**
 * Parse the analyst's confidence. Primary form is a number in [0, 1] (clamped);
 * falls back to the legacy HIGH/MEDIUM/LOW words, then to a conservative 0.3.
 */
function parseConfidence(raw: unknown, coin: string): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(1, Math.max(0, raw))
  }
  const str = String(raw ?? '').trim()
  const num = Number(str)
  if (str !== '' && Number.isFinite(num)) {
    return Math.min(1, Math.max(0, num))
  }
  const word = str.toUpperCase()
  if (word in LEGACY_CONFIDENCE_MAP) {
    logger.warn('Analyst returned legacy categorical confidence, mapping to number', { coin, word })
    return LEGACY_CONFIDENCE_MAP[word]
  }
  logger.warn('Unparseable confidence, defaulting to 0.3', { coin, raw: str.substring(0, 40) })
  return 0.3
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

  const confidence = parseConfidence(parsed.confidence, coin)

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
  // Regime is deterministic and cheap — recomputed here for the post-parse risk
  // sizing; the prompt's copy is rebuilt fresh inside the JIT thunk at dispatch.
  const regime = classifyRegime(market)

  // JIT data binding: the analyst runs on the SEQUENTIAL `analyse` lane, so a job
  // can sit queued behind another coin. Building the prompt — including the live
  // order book and candle history — is deferred into this thunk so it is fetched at
  // the moment of dispatch, never stale from queue wait. The endpoint is likewise
  // resolved fresh via `route`.
  const buildRequest = async (route: { model: string; maxTokens: number }): Promise<OpenAI.ChatCompletionCreateParams> => {
    const coinCtx = await getCoinPortfolioContext(coin)

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
    logger.info('Request LLM', { module: 'analyst', coin, regime: regime.summary, model: route.model })

    return {
      model: route.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // Single low temperature — the only subtask left is a discrete judgement (#1a)
      temperature: 0.2,
      max_tokens: route.maxTokens,
      response_format: { type: 'json_object' },
    }
  }

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const resp = await scheduleChat({
        module: 'analyst', lane: 'analyse', coin,
        route: () => resolveLLM('analyst'),
        build: buildRequest,
      })
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
        coin, message: e.message, status: e.status, model: resolveLLM('analyst').model,
      })
      return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis error', confidence: 0, horizon: undefined }
    }
  }

  return { coin, action: 'HOLD', quantity: 0, reason: 'Analysis failed after retry', confidence: 0, horizon: undefined }
}
