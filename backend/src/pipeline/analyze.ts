import { decisions, nowSql } from '../db/index.js'
import { researchCoin } from '../researcher/index.js'
import { extractResearch, selectArticles } from '../extractor/index.js'
import { analyzeSignal } from '../analyst/index.js'
import { getMarketContext, getPortfolioState } from '../portfolio/index.js'
import { Signal } from '../types.js'
import { logPipelineEvent } from './events.js'
import { checkCancelled } from './cancellation.js'

export type MarketDataItem = { symbol: string; price: number; change24h: number; volume: number }
export type CoinAnalysisResult = {
  data: MarketDataItem
  signal: Signal
  marketCtx: Awaited<ReturnType<typeof getMarketContext>>
  cycleId: string
}

/**
 * Run the full per-coin entry pipeline: research + market context (parallel) →
 * extraction → article selection → analyst signal. Emits a pipeline event at
 * each stage and records the resulting decision.
 */
export async function analyzeCoin(
  data: MarketDataItem,
  portfolioState: Awaited<ReturnType<typeof getPortfolioState>>,
  cycleId: string,
): Promise<CoinAnalysisResult> {
  // Research and market context are independent — fetch in parallel
  logPipelineEvent('research_started', data.symbol, cycleId, { symbol: data.symbol })
  checkCancelled(cycleId)
  const [rawResearch, marketCtx] = await Promise.all([
    researchCoin(data.symbol),
    getMarketContext(data.symbol, data.price),
  ])
  logPipelineEvent('research_completed', data.symbol, cycleId, {
    symbol: data.symbol,
    headlines: rawResearch.headlines,
    articles: rawResearch.articles,
    summary: rawResearch.summary,
  })

  checkCancelled(cycleId)
  logPipelineEvent('extraction_started', data.symbol, cycleId, { symbol: data.symbol, articleCount: rawResearch.articles.length })
  const extractedResearch = await extractResearch(rawResearch)
  logPipelineEvent('extraction_completed', data.symbol, cycleId, {
    symbol: data.symbol,
    articles: extractedResearch.articles,
    skipped_articles: extractedResearch.skipped_articles,
    aggregated_sentiment: extractedResearch.aggregated_sentiment,
    top_headlines: extractedResearch.top_headlines,
  })

  checkCancelled(cycleId)
  logPipelineEvent('selection_started', data.symbol, cycleId, {
    symbol: data.symbol, articleCount: extractedResearch.articles.length,
  })
  const selectedArticles = await selectArticles(data.symbol, extractedResearch.articles)
  logPipelineEvent('selection_completed', data.symbol, cycleId, {
    symbol: data.symbol,
    selectedCount: selectedArticles.length,
    totalCount: extractedResearch.articles.length,
    articles: selectedArticles,
  })

  checkCancelled(cycleId)
  const selectedResearch = { ...extractedResearch, articles: selectedArticles }
  logPipelineEvent('analysis_started', data.symbol, cycleId, {
    symbol: data.symbol, price: data.price, change24h: data.change24h, volume: data.volume,
    rsi14: marketCtx.rsi14, trend: marketCtx.trend, atr14: marketCtx.atr14,
    sma7: marketCtx.sma7, sma25: marketCtx.sma25, sma99: marketCtx.sma99,
    perf7d: marketCtx.perf7d, volatility: marketCtx.volatility,
  })

  const signal = await analyzeSignal(data.symbol, marketCtx, portfolioState, selectedResearch)

  logPipelineEvent('signal_generated', data.symbol, cycleId, {
    symbol: data.symbol, action: signal.action, reason: signal.reason, confidence: signal.confidence,
  })

  await decisions.insert({
    coin: data.symbol, action: signal.action, reason: signal.reason, confidence: signal.confidence,
    context: JSON.stringify({ price: data.price, selectedResearch }), triggered_trade_id: null, created_at: nowSql(),
  })

  return { data, signal, marketCtx, cycleId }
}
