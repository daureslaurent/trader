import { logger } from '../core/logger.js'
import { llmChat } from '../core/llm.js'
import { resolveLLM } from '../config/llm.js'
import { queryAll, queryOne, runSQL, getSettings, updateSetting } from '../db/index.js'
import { getMarketContext } from '../portfolio/market.js'
import { getTopPairs, fetchMarketData } from '../trader/index.js'
import { getOpenEntries } from '../portfolio/index.js'
import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { DiscoveryResult } from '../types.js'
import { buildDiscoveryPrompt } from './prompts.js'
import { LLMError } from '../core/errors.js'
import { isTradeable } from '../core/tradeable.js'
import { researchCoin } from '../researcher/index.js'
import { extractResearch, selectArticles, ExtractorLLMConfig } from '../extractor/index.js'

// Resolved fresh per call so per-module Settings overrides apply without a restart.
function getDiscovererExtractorConfig(): ExtractorLLMConfig {
  const { client, model, maxTokens, baseURL, fallback } = resolveLLM('discovererExtractor')
  return { client, model, maxTokens, baseURL, fallback }
}

let running = false

function logDiscoveryEvent(
  stage: string,
  coin: string,
  cycleId: string,
  data: Record<string, unknown>,
): void {
  const payload = JSON.stringify(data)
  const { lastInsertRowid } = runSQL(
    'INSERT INTO pipeline_events (coin, cycle_id, stage, data) VALUES (?, ?, ?, ?)',
    [coin, cycleId, stage, payload]
  )
  broadcast('pipeline_event', {
    id: lastInsertRowid,
    coin,
    cycle_id: cycleId,
    stage,
    data: payload,
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  })
}

async function evaluateCandidate(
  symbol: string,
  price: number,
  change24h: number,
  volume: number,
  cycleId: string,
): Promise<{ score: number; reasoning: string; marketData: Record<string, unknown> } | null> {
  logDiscoveryEvent('discovery_evaluating', symbol, cycleId, { symbol, price, volume })

  try {
    // Market context and research run in parallel
    logDiscoveryEvent('discovery_researching', symbol, cycleId, { symbol })
    const [marketCtx, rawResearch] = await Promise.all([
      getMarketContext(symbol, price),
      researchCoin(symbol),
    ])
    logDiscoveryEvent('discovery_researched', symbol, cycleId, {
      symbol,
      articleCount: rawResearch.articles.length,
      headlines: rawResearch.headlines,
    })

    logDiscoveryEvent('discovery_extracting', symbol, cycleId, {
      symbol,
      articleCount: rawResearch.articles.length,
    })
    const dExtractorConfig = getDiscovererExtractorConfig()
    const extractedResearch = await extractResearch(rawResearch, dExtractorConfig)
    const selectedArticles = await selectArticles(symbol, extractedResearch.articles, dExtractorConfig)
    logDiscoveryEvent('discovery_extracted', symbol, cycleId, {
      symbol,
      articleCount: selectedArticles.length,
      aggregated_sentiment: extractedResearch.aggregated_sentiment,
    })

    const research = {
      headlines: rawResearch.headlines,
      aggregated_sentiment: extractedResearch.aggregated_sentiment,
      articles: selectedArticles,
    }

    const { system, user } = buildDiscoveryPrompt(symbol, marketCtx, research)

    const scorer = resolveLLM('discoverer')
    logger.info('Request LLM', { module: 'discoverer', coin: symbol, model: scorer.model })
    const resp = await llmChat(scorer.client, {
      model: scorer.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: scorer.maxTokens,
      response_format: { type: 'json_object' },
    }, { module: 'discoverer', coin: symbol, cycle_id: cycleId, base_url: scorer.baseURL }, scorer.fallback)

    const content = resp.choices[0]?.message?.content ?? ''
    if (!content.trim()) throw new LLMError('Empty response')

    let parsed: Record<string, unknown>
    try {
      const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      parsed = JSON.parse(stripped)
    } catch {
      throw new LLMError(`JSON parse failed: ${content.substring(0, 200)}`)
    }

    const score = typeof parsed.score === 'number'
      ? Math.min(1, Math.max(0, parsed.score))
      : 0
    const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
      ? parsed.reasoning.trim()
      : 'No reasoning provided'

    const marketData = {
      price,
      change24h,
      volume,
      rsi14: marketCtx.rsi14,
      trend: marketCtx.trend,
      volatility: marketCtx.volatility,
      atr14: marketCtx.atr14,
      sma7: marketCtx.sma7,
      sma25: marketCtx.sma25,
      perf7d: marketCtx.perf7d,
    }

    logDiscoveryEvent('discovery_scored', symbol, cycleId, { symbol, score, reasoning, ...marketData })
    logger.info('Discovery scored', { symbol, score })
    return { score, reasoning, marketData }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('Failed to evaluate discovery candidate', { symbol, error: message })
    logDiscoveryEvent('discovery_error', symbol, cycleId, { symbol, error: message })
    return null
  }
}

export function isRunning(): boolean {
  return running
}

export async function runDiscovery(cycleId: string): Promise<void> {
  if (running) {
    logger.warn('Discovery pipeline already running, skipping')
    return
  }

  running = true
  logger.info('Discovery pipeline started', { cycleId })

  try {
    const settings = getSettings()

    const watchlist = settings.watchlist

    logDiscoveryEvent('discovery_started', 'DISCOVERY', cycleId, {
      top_n: settings.discover_top_n,
      min_volume_usd: settings.discover_min_volume_usd,
      watchlist,
    })

    const topPairs = await getTopPairs(settings.discover_top_n)

    const portfolioEntries = getOpenEntries() as unknown as { coin: string }[]

    // Normalize to base currency so BTC/USDC and BTC both match
    const toBase = (s: string) => (s.includes('/') ? s.split('/')[0] : s).toUpperCase()
    const excludedBases = new Set([
      ...watchlist.map(toBase),
      ...portfolioEntries.map(e => toBase(e.coin)),
    ])

    const candidates = topPairs.filter(s => !excludedBases.has(toBase(s)) && isTradeable(s))
    const excludedCount = topPairs.length - candidates.length

    logDiscoveryEvent('discovery_candidates_found', 'DISCOVERY', cycleId, {
      total_pairs: topPairs.length,
      candidates: candidates.length,
      excluded: excludedCount,
    })

    if (candidates.length === 0) {
      logDiscoveryEvent('discovery_completed', 'DISCOVERY', cycleId, {
        discovered: 0,
        message: 'No new candidates after filtering',
      })
      logger.info('Discovery: no new candidates')
      return
    }

    const marketDataList = await fetchMarketData(candidates)
    const volumeFiltered = marketDataList.filter(d => d.volume >= settings.discover_min_volume_usd)

    logger.info('Discovery candidates after volume filter', {
      before: candidates.length,
      after: volumeFiltered.length,
    })

    // Evaluate in batches of 5 to avoid overwhelming the LLM
    const BATCH_SIZE = 5
    const newWatchlist = [...watchlist]
    let autoAdded = 0
    let totalDiscovered = 0

    for (let i = 0; i < volumeFiltered.length; i += BATCH_SIZE) {
      const batch = volumeFiltered.slice(i, i + BATCH_SIZE)
      await Promise.allSettled(
        batch.map(async (d) => {
          const result = await evaluateCandidate(d.symbol, d.price, d.change24h, d.volume, cycleId)
          if (result === null) return

          const shouldAutoAdd = settings.discover_auto_add && result.score >= settings.discover_min_score
          const status = shouldAutoAdd ? 'auto_added' : 'pending'
          const marketDataJson = JSON.stringify(result.marketData)
          const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 19)

          const { lastInsertRowid } = runSQL(
            'INSERT INTO coin_discoveries (coin, score, reasoning, market_data, status, cycle_id) VALUES (?, ?, ?, ?, ?, ?)',
            [d.symbol, result.score, result.reasoning, marketDataJson, status, cycleId]
          )
          totalDiscovered++

          if (shouldAutoAdd && !newWatchlist.includes(d.symbol)) {
            newWatchlist.push(d.symbol)
            autoAdded++
            logger.info('Auto-added to watchlist via discovery', { coin: d.symbol, score: result.score })
          }

          const discoveryResult = {
            id: Number(lastInsertRowid),
            coin: d.symbol,
            score: result.score,
            reasoning: result.reasoning,
            market_data: marketDataJson,
            status,
            cycle_id: cycleId,
            created_at: createdAt,
          }
          bus.emit('coin_discovered', discoveryResult)
          broadcast('coin_discovered', discoveryResult)
        })
      )
    }

    if (autoAdded > 0) {
      updateSetting('watchlist', JSON.stringify(newWatchlist))
      bus.emit('settings_updated', getSettings() as import('../types.js').BotSettings)
    }

    logDiscoveryEvent('discovery_completed', 'DISCOVERY', cycleId, {
      evaluated: volumeFiltered.length,
      discovered: totalDiscovered,
      auto_added: autoAdded,
    })

    logger.info('Discovery pipeline completed', {
      evaluated: volumeFiltered.length,
      discovered: totalDiscovered,
      autoAdded,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logDiscoveryEvent('discovery_error', 'DISCOVERY', cycleId, { error: message })
    logger.error('Discovery pipeline failed', { error: message })
  } finally {
    running = false
  }
}

export function getDiscoveries(limit = 50): DiscoveryResult[] {
  return queryAll(
    'SELECT * FROM coin_discoveries ORDER BY created_at DESC LIMIT ?',
    [limit]
  ) as unknown as DiscoveryResult[]
}

export function approveDiscovery(id: number): { ok: boolean; error?: string } {
  const discovery = queryOne('SELECT * FROM coin_discoveries WHERE id = ?', [id])
  if (!discovery) return { ok: false, error: 'Discovery not found' }
  if (discovery.status !== 'pending') return { ok: false, error: `Already ${discovery.status}` }

  const settings = getSettings()
  const watchlist = [...settings.watchlist]
  const coin = discovery.coin as string

  if (!watchlist.includes(coin)) {
    watchlist.push(coin)
    updateSetting('watchlist', JSON.stringify(watchlist))
    bus.emit('settings_updated', getSettings() as import('../types.js').BotSettings)
  }

  runSQL("UPDATE coin_discoveries SET status = 'approved' WHERE id = ?", [id])
  logger.info('Discovery approved, added to watchlist', { coin, id })
  return { ok: true }
}

export function rejectDiscovery(id: number): { ok: boolean; error?: string } {
  const discovery = queryOne('SELECT * FROM coin_discoveries WHERE id = ?', [id])
  if (!discovery) return { ok: false, error: 'Discovery not found' }
  if (discovery.status !== 'pending') return { ok: false, error: `Already ${discovery.status}` }

  runSQL("UPDATE coin_discoveries SET status = 'rejected' WHERE id = ?", [id])
  logger.info('Discovery rejected', { coin: discovery.coin, id })
  return { ok: true }
}

export function deleteDiscovery(id: number): void {
  runSQL('DELETE FROM coin_discoveries WHERE id = ?', [id])
}
