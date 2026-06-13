import OpenAI from 'openai'
import { logger } from '../core/logger.js'
import { llmChat } from '../core/llm.js'
import { queryAll, queryOne, runSQL, getSettings } from '../db/index.js'
import { resolveLLM } from '../config/llm.js'
import { broadcast } from '../api/ws.js'
import { bus } from '../core/events.js'
import * as priceCache from '../market/index.js'
import { fetchMarketData } from '../trader/index.js'
import { getCoinEntries, getUsdcEntry, getMarketContext, classifyRegime } from '../portfolio/index.js'
import { LLMError } from '../core/errors.js'
import type { PortfolioSummary, PortfolioEntry } from '../types.js'
import { buildSummaryPrompt, fmtOffsetLabel, SummaryContext, SummaryHolding, SummaryTrade, SummaryClosed, SummaryMonitorAction } from './prompts.js'

let running = false

export function isRunning(): boolean {
  return running
}

// Resolves the summary engine's effective model/endpoint from Settings (falling
// back to the SUMMARY_* env config). Exported so the API can badge the active model.
export function getActiveSummaryModel(): { model: string; baseURL: string; maxTokens: number } {
  const { model, baseURL, maxTokens } = resolveLLM('summary')
  return { model, baseURL, maxTokens }
}

interface RawSummary {
  summary: string
  what_happened?: string | null
  health?: string | null
  risk_level?: string | null
  observations?: unknown
  suggestions?: unknown
}

const HEALTH = ['strong', 'stable', 'cautious', 'at_risk']
const RISK = ['low', 'moderate', 'elevated', 'high']

function parseSummary(content: string): RawSummary {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/)
    if (!match) throw new LLMError('No JSON found in summary response')
    parsed = JSON.parse(match[0])
  }
  const obj = (parsed as Record<string, unknown>)?.summary && typeof (parsed as Record<string, unknown>).summary === 'object'
    ? (parsed as Record<string, unknown>).summary
    : parsed
  const c = obj as Record<string, unknown>
  if (typeof c !== 'object' || c === null || typeof c.summary !== 'string' || !c.summary.trim()) {
    throw new LLMError('Invalid summary in response (missing "summary" string)')
  }
  return c as unknown as RawSummary
}

function normLabel(value: unknown, allowed: string[]): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase().replace(/\s+/g, '_')
  return allowed.includes(v) ? v : null
}

// Coerce an LLM list field to a JSON array string of short strings, or null.
function normList(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const items = value
    .map(v => (typeof v === 'string' ? v.trim() : String(v)))
    .filter(s => s.length > 0)
    .slice(0, 8)
    .map(s => s.slice(0, 400))
  return items.length ? JSON.stringify(items) : null
}

// Delete summaries older than the retention window. 0 = keep forever.
function pruneSummaries(retainDays: number): void {
  if (!retainDays || retainDays <= 0) return
  runSQL(
    `DELETE FROM portfolio_summaries WHERE created_at < datetime('now', ?)`,
    [`-${Math.floor(retainDays)} days`],
  )
}

// Aggregate possibly-multiple OPEN entries per coin into one holding line.
function groupEntries(entries: PortfolioEntry[]): Map<string, { quantity: number; cost: number }> {
  const byCoin = new Map<string, { quantity: number; cost: number }>()
  for (const e of entries) {
    const cur = byCoin.get(e.coin) ?? { quantity: 0, cost: 0 }
    cur.quantity += e.quantity
    cur.cost += e.quantity * e.buy_price
    byCoin.set(e.coin, cur)
  }
  return byCoin
}

export function getSummaries(limit = 50): PortfolioSummary[] {
  return queryAll(
    'SELECT * FROM portfolio_summaries ORDER BY created_at DESC LIMIT ?',
    [Math.min(Math.max(limit, 1), 200)],
  ) as unknown as PortfolioSummary[]
}

export function getLatestSummary(): PortfolioSummary | null {
  return queryOne('SELECT * FROM portfolio_summaries ORDER BY created_at DESC LIMIT 1') as PortfolioSummary | null
}

export async function runPortfolioSummary(cycleId: string): Promise<void> {
  if (running) {
    logger.warn('Portfolio summary already running, skipping')
    return
  }
  running = true
  logger.info('Portfolio summary started', { cycleId })
  broadcast('summary_started', { cycle_id: cycleId })

  try {
    const s = getSettings()
    const utcOffsetHours = s.utc_offset_hours
    const feeRate = s.fee_rate

    const usdcEntry = getUsdcEntry()
    const usdcBalance = usdcEntry ? usdcEntry.quantity : 0
    const coinEntries = getCoinEntries()
    const grouped = groupEntries(coinEntries)
    const coins = [...grouped.keys()]

    if (coins.length > 0) priceCache.subscribe(coins)

    // Live Binance 24h data + price; fall back to the price cache if the REST call fails.
    let marketData: Awaited<ReturnType<typeof fetchMarketData>> = []
    if (coins.length > 0) {
      try {
        marketData = await fetchMarketData(coins)
      } catch (err) {
        logger.warn('Summary: fetchMarketData failed, falling back to price cache', { error: (err as Error).message })
      }
    }
    const mdByCoin = new Map(marketData.map(m => [m.symbol, m]))
    const allPrices = priceCache.getAll()

    const priceFor = (coin: string, fallback: number): number =>
      mdByCoin.get(coin)?.price ?? allPrices.get(coin)?.price ?? fallback

    // Build per-coin holdings enriched with deterministic Binance market context.
    const holdings: SummaryHolding[] = await Promise.all(
      coins.map(async (coin): Promise<SummaryHolding> => {
        const g = grouped.get(coin)!
        const avgBuyPrice = g.quantity > 0 ? g.cost / g.quantity : null
        const currentPrice = priceFor(coin, avgBuyPrice ?? 0)
        const valueUsd = g.quantity * currentPrice
        const unrealizedPnlUsd = avgBuyPrice != null ? (currentPrice - avgBuyPrice) * g.quantity : null
        const unrealizedPnlPct = avgBuyPrice != null && avgBuyPrice > 0
          ? ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100
          : null

        let rsi14 = 50, trend: SummaryHolding['trend'] = 'ranging', volatility: SummaryHolding['volatility'] = 'normal', regime = '—'
        let change24h = mdByCoin.get(coin)?.change24h ?? 0
        try {
          const mc = await getMarketContext(coin, currentPrice)
          rsi14 = mc.rsi14
          trend = mc.trend
          volatility = mc.volatility
          regime = classifyRegime(mc).summary
          if (mdByCoin.get(coin)?.change24h == null) change24h = mc.change24h
        } catch (err) {
          logger.warn('Summary: market context failed', { coin, error: (err as Error).message })
        }

        const pos = queryOne(
          "SELECT stop_loss, take_profit, horizon FROM positions WHERE coin = ? AND status = 'OPEN' LIMIT 1",
          [coin],
        ) as { stop_loss: number | null; take_profit: number | null; horizon: string | null } | null

        const srcRow = queryOne(
          "SELECT source FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1",
          [coin],
        ) as { source: string } | null

        return {
          coin,
          quantity: g.quantity,
          avgBuyPrice,
          currentPrice,
          valueUsd,
          allocationPct: 0, // filled after the total is known
          unrealizedPnlUsd,
          unrealizedPnlPct,
          change24h,
          rsi14,
          trend,
          volatility,
          regime,
          stopLoss: pos?.stop_loss ?? null,
          takeProfit: pos?.take_profit ?? null,
          horizon: pos?.horizon ?? null,
          source: srcRow?.source ?? 'trade',
        }
      }),
    )

    const totalValueUsd = usdcBalance + holdings.reduce((sum, h) => sum + h.valueUsd, 0)
    for (const h of holdings) h.allocationPct = totalValueUsd > 0 ? (h.valueUsd / totalValueUsd) * 100 : 0
    holdings.sort((a, b) => b.valueUsd - a.valueUsd)

    const openBotPositions = (queryOne("SELECT COUNT(*) AS cnt FROM positions WHERE status = 'OPEN'") as { cnt: number } | null)?.cnt ?? 0

    const recentTrades: SummaryTrade[] = (queryAll(
      "SELECT side, coin, quantity, price, total, created_at FROM trades WHERE status = 'EXECUTED' ORDER BY created_at DESC LIMIT 10",
    ) as { side: string; coin: string; quantity: number; price: number; total: number; created_at: string }[]).map(t => ({
      side: t.side as 'BUY' | 'SELL',
      coin: t.coin,
      quantity: t.quantity,
      price: t.price,
      total: t.total,
      date: t.created_at,
    }))

    const recentlyClosed: SummaryClosed[] = (queryAll(
      `SELECT p.coin, p.status, p.entry_price, p.pnl, p.created_at AS opened_at,
              t.price AS exit_price, t.created_at AS closed_at
       FROM positions p
       LEFT JOIN trades t ON p.exit_id = t.id
       WHERE p.status != 'OPEN'
       ORDER BY COALESCE(t.created_at, p.created_at) DESC LIMIT 8`,
    ) as { coin: string; status: string; entry_price: number | null; pnl: number | null; exit_price: number | null; closed_at: string | null; opened_at: string }[]).map(c => ({
      coin: c.coin,
      status: c.status,
      entryPrice: c.entry_price,
      exitPrice: c.exit_price,
      realizedPnl: c.pnl,
      closedAt: c.closed_at ?? c.opened_at,
    }))

    const monitorActions: SummaryMonitorAction[] = (queryAll(
      `SELECT coin, action, confidence, reasoning, reduce_to_pct, new_stop_loss, new_take_profit, created_at
       FROM position_reviews ORDER BY created_at DESC LIMIT 12`,
    ) as { coin: string; action: string; confidence: number; reasoning: string; reduce_to_pct: number | null; new_stop_loss: number | null; new_take_profit: number | null; created_at: string }[]).map(r => ({
      coin: r.coin,
      action: r.action as SummaryMonitorAction['action'],
      confidence: r.confidence,
      reasoning: r.reasoning,
      reduceToPct: r.reduce_to_pct,
      newStopLoss: r.new_stop_loss,
      newTakeProfit: r.new_take_profit,
      createdAt: r.created_at,
    }))

    const snaps = (queryAll(
      'SELECT total_value_usd, created_at FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 8',
    ) as { total_value_usd: number; created_at: string }[]).reverse()
    const valueTrend = snaps.map(s => ({ date: s.created_at.slice(0, 16), value: Number(s.total_value_usd) }))
    const valueChangePct = valueTrend.length >= 2 && valueTrend[0].value > 0
      ? ((valueTrend[valueTrend.length - 1].value - valueTrend[0].value) / valueTrend[0].value) * 100
      : null

    const now = new Date(Date.now() + utcOffsetHours * 3600000)
      .toISOString().replace('T', ' ').slice(0, 19) + ' ' + fmtOffsetLabel(utcOffsetHours)

    const ctx: SummaryContext = {
      generatedAt: now,
      totalValueUsd,
      usdcBalance,
      usdcPct: totalValueUsd > 0 ? (usdcBalance / totalValueUsd) * 100 : 100,
      holdingsCount: holdings.length,
      openBotPositions,
      maxOpenPositions: s.max_open_positions,
      feeRatePct: feeRate * 100,
      valueTrend,
      valueChangePct,
      holdings,
      recentTrades,
      recentlyClosed,
      monitorActions,
    }

    const active = getActiveSummaryModel()
    const client = new OpenAI({ baseURL: active.baseURL, apiKey: 'ollama' })
    const { system, user } = buildSummaryPrompt(ctx)

    logger.info('Request LLM', { module: 'summary', model: active.model, holdings: holdings.length })

    let raw: RawSummary | null = null
    for (let attempt = 0; attempt <= 1; attempt++) {
      let resp: Awaited<ReturnType<typeof llmChat>>
      try {
        resp = await llmChat(client, {
          model: active.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.3,
          max_tokens: active.maxTokens,
          response_format: { type: 'json_object' },
        }, { module: 'summary', cycle_id: cycleId, base_url: active.baseURL })
      } catch (apiErr) {
        if (attempt === 0) { logger.warn('Summary LLM API error, retrying', { error: (apiErr as Error).message }); continue }
        throw apiErr
      }

      const content = resp.choices[0]?.message?.content ?? ''
      if (!content.trim()) {
        if (attempt === 0) { logger.warn('Empty summary response, retrying'); continue }
        throw new LLMError('Empty LLM response')
      }
      try {
        raw = parseSummary(content)
      } catch (err) {
        if (attempt === 0) { logger.warn('Summary parse failed, retrying', { error: (err as Error).message }); continue }
        throw err
      }
      break
    }

    if (!raw) throw new LLMError('Summary returned no valid result after retries')

    const health = normLabel(raw.health, HEALTH)
    const riskLevel = normLabel(raw.risk_level, RISK)
    const observations = normList(raw.observations)
    const suggestions = normList(raw.suggestions)
    const whatHappened = typeof raw.what_happened === 'string' && raw.what_happened.trim() ? raw.what_happened.trim() : null
    const snapshot = JSON.stringify(ctx)

    const { lastInsertRowid } = runSQL(
      `INSERT INTO portfolio_summaries (summary, what_happened, health, risk_level, observations, suggestions, snapshot, model, cycle_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [raw.summary.trim(), whatHappened, health, riskLevel, observations, suggestions, snapshot, active.model, cycleId],
    )

    const summary: PortfolioSummary = {
      id: Number(lastInsertRowid),
      summary: raw.summary.trim(),
      what_happened: whatHappened,
      health,
      risk_level: riskLevel,
      observations,
      suggestions,
      snapshot,
      model: active.model,
      cycle_id: cycleId,
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    }

    pruneSummaries(s.summary_retain_days)

    logger.info('Portfolio summary saved', { cycleId, id: summary.id, health, riskLevel })
    broadcast('summary_completed', { cycle_id: cycleId, summary })
    bus.emit('portfolio_summary_created', summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Portfolio summary failed', { cycleId, error: message })
    broadcast('summary_error', { cycle_id: cycleId, error: message })
  } finally {
    running = false
  }
}
