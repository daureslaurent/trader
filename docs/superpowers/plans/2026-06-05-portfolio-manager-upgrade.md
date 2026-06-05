# Portfolio Manager Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the trading bot from signal-based to autonomous portfolio manager with risk management, technical context, and portfolio-aware LLM decisions.

**Architecture:** New `portfolio/` module (market context, risk engine, rich prompts). New `positions` DB table for SL/TP tracking. Updated analyst prompt receives full portfolio + market + news context. Trading loop integrates risk checks before each cycle.

**Tech Stack:** SQLite (sql.js), Express, ccxt, OpenAI-compatible LLM, React

---

### Task 1: Add positions table, new types, and risk settings

**Files:**
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/src/types.ts`

- [ ] **Step 1: Add positions table to schema.ts**

In `backend/src/db/schema.ts`, add before the settings INSERT:

```sql
CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  coin        TEXT NOT NULL,
  side        TEXT NOT NULL CHECK(side IN ('BUY')),
  quantity    REAL NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss   REAL NOT NULL,
  take_profit REAL,
  current_sl  REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED','SL_HIT','TP_HIT')),
  entry_id    INTEGER,
  exit_id     INTEGER,
  pnl         REAL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Add risk settings defaults**

In `backend/src/db/schema.ts`, add to the settings INSERT:

```sql
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('stop_loss_atr', '2'),
  ('take_profit_atr', '4'),
  ('max_risk_per_trade', '0.02'),
  ('max_open_positions', '5');
```

- [ ] **Step 3: Add new types to types.ts**

After existing types in `backend/src/types.ts`, add:

```typescript
export interface MarketContext {
  price: number
  change24h: number
  volume: number
  rsi14: number
  sma7: number
  sma25: number
  sma99: number
  atr14: number
  trend: 'uptrend' | 'downtrend' | 'ranging'
  perf7d: number
  volatility: 'high' | 'normal' | 'low'
}

export interface PortfolioState {
  totalValueUsd: number
  positions: { coin: string; allocationPct: number; pnlPct: number }[]
  diversificationScore: number
  openPositionCount: number
  maxOpenPositions: number
  targetAllocationPct: number
}

export interface RiskConfig {
  stopLossAtrMultiplier: number
  takeProfitAtrMultiplier: number
  maxRiskPerTrade: number
  maxOpenPositions: number
}

export interface PositionRecord {
  id: number
  coin: string
  side: 'BUY'
  quantity: number
  entry_price: number
  stop_loss: number
  take_profit: number | null
  current_sl: number
  status: string
  pnl: number | null
  created_at: string
}
```

- [ ] **Step 4: Run type check**

```bash
cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 5: Commit**

```bash
cd /home/dauresl/cryptoBot && git add backend/src/db/schema.ts backend/src/types.ts && git commit -m "feat: add positions table, risk types, and settings defaults"
```

---

### Task 2: Create portfolio/market.ts — technical indicators

**Files:**
- Create: `backend/src/portfolio/market.ts`

- [ ] **Step 1: Create the market context module**

Create `backend/src/portfolio/market.ts`:

```typescript
import { logger } from '../core/logger.js'
import { MarketContext } from '../types.js'

interface OHLCV {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function computeSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

function computeRSI(values: number[], period: number): number {
  if (values.length < period + 1) return 50
  const changes = []
  for (let i = 1; i < values.length; i++) changes.push(values[i] - values[i - 1])
  const recent = changes.slice(-period)
  const gains = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period
  const losses = recent.filter(c => c < 0).reduce((a, b) => a + Math.abs(b), 0) / period
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - (100 / (1 + rs))
}

function computeATR(candles: OHLCV[], period: number): number {
  if (candles.length < period + 1) return 0
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high
    const low = candles[i].low
    const prevClose = candles[i - 1].close
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
  }
  const recentTRs = trs.slice(-period)
  return recentTRs.reduce((a, b) => a + b, 0) / period
}

export async function getMarketContext(symbol: string, price: number): Promise<MarketContext> {
  try {
    const { default: ccxt } = await import('ccxt')
    const exchange = new ccxt.binance()
    const ohlcvRaw: unknown[][] = await exchange.fetchOHLCV(symbol, '1h', undefined, 168)
    const candles: OHLCV[] = (ohlcvRaw || []).map(c => ({
      timestamp: c[0] as number,
      open: c[1] as number,
      high: c[2] as number,
      low: c[3] as number,
      close: c[4] as number,
      volume: c[5] as number,
    }))

    if (candles.length < 14) {
      logger.warn('Not enough OHLCV data for indicators', { symbol, count: candles.length })
      return {
        price, change24h: 0, volume: 0,
        rsi14: 50, sma7: price, sma25: price, sma99: price,
        atr14: 0, trend: 'ranging', perf7d: 0, volatility: 'normal',
      }
    }

    const closes = candles.map(c => c.close)
    const rsi14 = computeRSI(closes, 14)
    const sma7 = computeSMA(closes, 7)
    const sma25 = computeSMA(closes, 25)
    const sma99 = computeSMA(closes, Math.min(99, closes.length))
    const atr14 = computeATR(candles, 14)
    const perf7d = closes.length >= 168
      ? ((closes[closes.length - 1] - closes[closes.length - 168]) / closes[closes.length - 168]) * 100
      : 0

    let trend: 'uptrend' | 'downtrend' | 'ranging' = 'ranging'
    if (sma7 > sma25 && sma25 > sma99) trend = 'uptrend'
    else if (sma7 < sma25 && sma25 < sma99) trend = 'downtrend'

    const avgATR = computeATR(candles.slice(0, 168), 14) || atr14
    const volatility: 'high' | 'normal' | 'low' =
      atr14 > avgATR * 1.5 ? 'high' : atr14 < avgATR * 0.5 ? 'low' : 'normal'

    const lastCandle = candles[candles.length - 1]

    return {
      price,
      change24h: closes.length >= 24
        ? ((closes[closes.length - 1] - closes[closes.length - 25]) / closes[closes.length - 25]) * 100
        : 0,
      volume: lastCandle.volume,
      rsi14: Math.round(rsi14 * 10) / 10,
      sma7: Math.round(sma7 * 100) / 100,
      sma25: Math.round(sma25 * 100) / 100,
      sma99: Math.round(sma99 * 100) / 100,
      atr14: Math.round(atr14 * 100) / 100,
      trend,
      perf7d: Math.round(perf7d * 10) / 10,
      volatility,
    }
  } catch (err) {
    logger.warn('Failed to fetch market context', { symbol, error: (err as Error).message })
    return {
      price, change24h: 0, volume: 0,
      rsi14: 50, sma7: price, sma25: price, sma99: price,
      atr14: 0, trend: 'ranging', perf7d: 0, volatility: 'normal',
    }
  }
}
```

- [ ] **Step 2: Run type check**

```bash
cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /home/dauresl/cryptoBot && git add backend/src/portfolio/market.ts && git commit -m "feat: add market context with technical indicators (RSI, SMA, ATR, trend)"
```

---

### Task 3: Create portfolio/risk.ts — position sizing and SL/TP

**Files:**
- Create: `backend/src/portfolio/risk.ts`

- [ ] **Step 1: Create the risk module**

Create `backend/src/portfolio/risk.ts`:

```typescript
import { BotSettings, PositionRecord, RiskConfig } from '../types.js'

function parseSettings(s: BotSettings): RiskConfig {
  return {
    stopLossAtrMultiplier: parseFloat((s as any).stop_loss_atr || '2'),
    takeProfitAtrMultiplier: parseFloat((s as any).take_profit_atr || '4'),
    maxRiskPerTrade: parseFloat((s as any).max_risk_per_trade || '0.02'),
    maxOpenPositions: parseInt((s as any).max_open_positions || '5', 10),
  }
}

export function calculatePositionSize(
  price: number,
  atr: number,
  confidence: number,
  balanceUsd: number,
  settings: BotSettings,
): number {
  const risk = parseSettings(settings)
  const targetRisk = balanceUsd * risk.maxRiskPerTrade
  const riskAdjusted = targetRisk * Math.max(confidence, 0.1)
  if (atr <= 0 || risk.stopLossAtrMultiplier <= 0) {
    return Math.min(riskAdjusted / price, settings.max_position_size_usd / price)
  }
  const volAdjusted = riskAdjusted / (atr * risk.stopLossAtrMultiplier)
  const maxQty = settings.max_position_size_usd / price
  return Math.min(volAdjusted, maxQty)
}

export function calculateStopLoss(
  entryPrice: number,
  atr: number,
  settings: BotSettings,
): number {
  const risk = parseSettings(settings)
  return entryPrice - (atr * risk.stopLossAtrMultiplier)
}

export function calculateTakeProfit(
  entryPrice: number,
  atr: number,
  settings: BotSettings,
): number {
  const risk = parseSettings(settings)
  return entryPrice + (atr * risk.takeProfitAtrMultiplier)
}

export function checkPosition(currentPrice: number, position: PositionRecord): 'HOLD' | 'SL_HIT' | 'TP_HIT' {
  if (position.status !== 'OPEN') return 'HOLD'
  if (position.take_profit && currentPrice >= position.take_profit) return 'TP_HIT'
  if (currentPrice <= position.stop_loss) return 'SL_HIT'
  return 'HOLD'
}

export { parseSettings }
export type { RiskConfig }
```

- [ ] **Step 2: Run type check**

```bash
cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /home/dauresl/cryptoBot && git add backend/src/portfolio/risk.ts && git commit -m "feat: add risk module with position sizing, SL/TP, and position checking"
```

---

### Task 4: Create portfolio/index.ts and portfolio/prompts.ts

**Files:**
- Create: `backend/src/portfolio/index.ts`
- Create: `backend/src/portfolio/prompts.ts`

- [ ] **Step 1: Create the rich prompt builder**

Create `backend/src/portfolio/prompts.ts`:

```typescript
import { MarketContext, PortfolioState, BotSettings } from '../types.js'
import { ExtractedResearch } from '../extractor/index.js'

export function buildAnalysisPrompt(
  coin: string,
  market: MarketContext,
  portfolio: PortfolioState,
  settings: BotSettings,
  research: ExtractedResearch,
): { system: string; user: string } {
  const system = `You are an autonomous crypto portfolio manager. You manage a portfolio with discipline and patience.

KEY RULES (non-negotiable):
- Only BUY if conviction > 0.6 AND the coin fits portfolio diversification
- Only SELL if: negative catalyst, OR position exceeds target allocation meaningfully
- Prefer HOLD over uncertain trades. Missing a move is better than taking a bad trade.
- Position sizing: scale quantity proportionally to your confidence
- Medium-term horizon: decisions are evaluated over days to weeks

PORTFOLIO STATE:
- Total portfolio value: $${portfolio.totalValueUsd.toFixed(2)}
- Current open positions: ${portfolio.openPositionCount} / ${portfolio.maxOpenPositions}
- Target allocation per coin: ${(portfolio.targetAllocationPct * 100).toFixed(1)}%
- Diversification score: ${portfolio.diversificationScore.toFixed(2)} (0=poor, 1=perfect)

OPEN POSITIONS:
${portfolio.positions.length === 0 ? 'None' : portfolio.positions.map(p =>
  `- ${p.coin}: ${(p.allocationPct * 100).toFixed(1)}% of portfolio, PnL: ${p.pnlPct > 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%`
).join('\n')}

OUTPUT FORMAT — respond with ONLY a JSON object:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0.0-1.0,
  "reasoning": "concise explanation of your logic",
  "suggested_position_size_usd": number
}`

  const articlesText = research.articles.length > 0
    ? research.articles.map(a =>
        `\n--- ${a.title} ---
Relevance: ${a.relevance_score}
Sentiment: ${a.sentiment}
Summary: ${a.summary}
Key Points: ${a.key_points.join(', ')}`
      ).join('\n')
    : 'No article data available.'

  const user = `ANALYZE: ${coin}

MARKET DATA:
- Price: $${market.price}
- 24h Change: ${market.change24h > 0 ? '+' : ''}${market.change24h}%
- Volume: $${market.volume}
- RSI(14): ${market.rsi14}
- SMA(7): $${market.sma7}
- SMA(25): $${market.sma25}
- SMA(99): $${market.sma99}
- ATR(14): $${market.atr14}
- Trend: ${market.trend}
- 7d Performance: ${market.perf7d > 0 ? '+' : ''}${market.perf7d}%
- Volatility: ${market.volatility}

NEWS:
Aggregated Sentiment: ${research.aggregated_sentiment}
Top Headlines: ${research.top_headlines.join('. ')}

Articles:${articlesText}

Decide: BUY, SELL, or HOLD for ${coin}?`

  return { system, user }
}
```

- [ ] **Step 2: Create the portfolio module index**

Create `backend/src/portfolio/index.ts`:

```typescript
import { queryAll, queryOne, runSQL, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { bus } from '../core/events.js'
import { broadcast } from '../api/ws.js'
import { getMarketContext } from './market.js'
import { checkPosition, parseSettings } from './risk.js'
import { buildAnalysisPrompt } from './prompts.js'
import {
  MarketContext, PortfolioState, PositionRecord,
  BotSettings, AccountBalance, Signal,
} from '../types.js'

export function getOpenPositions(): PositionRecord[] {
  return queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as PositionRecord[]
}

export function checkOpenPositions(): void {
  const positions = getOpenPositions()
  if (positions.length === 0) return

  logger.debug('Checking open positions', { count: positions.length })

  for (const pos of positions) {
    try {
      if (!pos.coin) continue
      const { default: ccxt } = await_import_ccxt()
      const exchange = new ccxt.binance()
      const ticker = await exchange.fetchTicker(pos.coin)
      const currentPrice = ticker.last
      if (!currentPrice) continue

      const status = checkPosition(currentPrice, pos)
      if (status === 'HOLD') continue

      logger.info(`Position ${status}`, { coin: pos.coin, entry: pos.entry_price, current: currentPrice })
      bus.emit(status === 'SL_HIT' ? 'stop_loss_hit' : 'take_profit_hit', { positionId: pos.id, coin: pos.coin, price: currentPrice })
    } catch (err) {
      logger.warn('Failed to check position', { coin: pos.coin, error: (err as Error).message })
    }
  }
}

async function await_import_ccxt() {
  const ccxt = await import('ccxt')
  return ccxt
}

export function computePortfolioState(
  balance: Record<string, { free: number; total: number }>,
  marketData: { symbol: string; price: number }[],
  settings: BotSettings,
): PortfolioState {
  const coinValues: Record<string, number> = {}
  let totalValue = 0

  for (const coin of Object.keys(balance)) {
    if (coin === 'USDT') continue
    const md = marketData.find(d => d.symbol.replace('/USDT', '') === coin)
    if (md) {
      const val = balance[coin].total * md.price
      coinValues[coin] = val
      totalValue += val
    }
  }

  if (balance['USDT']) {
    totalValue += balance['USDT'].total
    coinValues['USDT'] = balance['USDT'].total
  }

  const risk = parseSettings(settings)
  const openPositions = getOpenPositions()

  const positions = openPositions.map(p => {
    const allocationPct = totalValue > 0 ? (coinValues[p.coin.replace('/USDT', '')] || 0) / totalValue : 0
    const currentPrice = marketData.find(d => d.symbol === p.coin)?.price || p.entry_price
    const pnlPct = ((currentPrice - p.entry_price) / p.entry_price) * 100
    return { coin: p.coin, allocationPct, pnlPct }
  })

  const coinCount = Object.keys(coinValues).length || 1
  const targetAllocationPct = 1 / coinCount

  const allocs = Object.values(coinValues)
  const idealAlloc = totalValue / coinCount
  const deviations = allocs.map(a => Math.abs(a - idealAlloc) / idealAlloc)
  const avgDeviation = deviations.reduce((s, d) => s + d, 0) / deviations.length || 0
  const diversificationScore = Math.max(0, 1 - avgDeviation)

  return {
    totalValueUsd: totalValue,
    positions,
    diversificationScore,
    openPositionCount: openPositions.length,
    maxOpenPositions: risk.maxOpenPositions,
    targetAllocationPct,
  }
}

export { getMarketContext, buildAnalysisPrompt }
```

- [ ] **Step 3: Update event bus with new events**

In `backend/src/core/events.ts`, add to EventMap:

```typescript
  stop_loss_hit: [{ positionId: number; coin: string; price: number }]
  take_profit_hit: [{ positionId: number; coin: string; price: number }]
```

- [ ] **Step 4: Run type check**

```bash
cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 5: Commit**

```bash
cd /home/dauresl/cryptoBot && git add backend/src/portfolio/ backend/src/core/events.ts && git commit -m "feat: add portfolio module with rich prompts and position monitoring"
```

---

### Task 5: Update analyst to use new context

**Files:**
- Modify: `backend/src/analyst/service.ts`
- Modify: `backend/src/analyst/prompts.ts` (simplify, defer to portfolio prompts)

- [ ] **Step 1: Update analyst service**

Replace `backend/src/analyst/service.ts`:

```typescript
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
```

- [ ] **Step 2: Run type check**

```bash
cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /home/dauresl/cryptoBot && git add backend/src/analyst/service.ts && git commit -m "feat: update analyst to receive full portfolio and market context"
```

---

### Task 6: Update index.ts trading loop

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Rewrite the trading loop**

Replace the content of `backend/src/index.ts` with the updated version below. The key changes:
- Add SL/TP check before the coin loop
- Import getMarketContext, getOpenPositions, checkOpenPositions, computePortfolioState, risk functions
- Fix the balance calculation bug (use each coin's price separately)
- Use computePortfolioState instead of inline balance calc
- Pass MarketContext and PortfolioState to analyzeSignal
- Create position records on BUY, close on SELL

Full file:

```typescript
import { initDB, runSQL, getSettings } from './db/index.js'
import { config } from './config/index.js'
import { logger } from './core/logger.js'
import { bus } from './core/events.js'
import { startAPI } from './api/index.js'
import { startTelegramBot, sendApprovalMessage } from './telegram/index.js'
import { fetchMarketData, fetchBalance, executeTrade, getTopPairs } from './trader/index.js'
import { researchCoin } from './researcher/index.js'
import { extractResearch } from './extractor/index.js'
import { analyzeSignal } from './analyst/index.js'
import { getMarketContext, checkOpenPositions, computePortfolioState } from './portfolio/index.js'
import { calculatePositionSize, calculateStopLoss, calculateTakeProfit } from './portfolio/risk.js'
import { broadcast } from './api/ws.js'
import { Signal, ApprovalRequest, PipelineStage } from './types.js'

let pendingApprovals: Map<number, Signal> = new Map()
let approvalTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()
let cycleCounter = 0

function logPipelineEvent(
  stage: PipelineStage,
  coin: string,
  cycleId: string,
  data: Record<string, unknown>
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

// --- Position close handler ---
bus.on('stop_loss_hit', async ({ positionId, coin, price }: { positionId: number; coin: string; price: number }) => {
  logger.warn('Stop loss triggered', { coin, positionId, price })
  try {
    const signal: Signal = { coin, action: 'SELL', quantity: 0, reason: 'Stop loss', confidence: 1 }
    const result = await executeTrade(signal)
    runSQL(
      "UPDATE positions SET status = 'SL_HIT', exit_id = (SELECT id FROM trades WHERE coin = ? ORDER BY id DESC LIMIT 1), pnl = (quantity * (? - entry_price)) WHERE id = ?",
      [coin, price, positionId]
    )
    runSQL(
      'INSERT INTO trades (coin, side, quantity, price, total, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [coin, 'SELL', result.amount, result.price, result.cost, 'EXECUTED', 1]
    )
  } catch (err) {
    logger.error('Failed to execute stop loss', { coin, error: (err as Error).message })
  }
})

bus.on('take_profit_hit', async ({ positionId, coin, price }: { positionId: number; coin: string; price: number }) => {
  logger.info('Take profit triggered', { coin, positionId, price })
  try {
    const signal: Signal = { coin, action: 'SELL', quantity: 0, reason: 'Take profit', confidence: 1 }
    const result = await executeTrade(signal)
    runSQL(
      "UPDATE positions SET status = 'TP_HIT', exit_id = (SELECT id FROM trades WHERE coin = ? ORDER BY id DESC LIMIT 1), pnl = (quantity * (? - entry_price)) WHERE id = ?",
      [coin, price, positionId]
    )
    runSQL(
      'INSERT INTO trades (coin, side, quantity, price, total, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [coin, 'SELL', result.amount, result.price, result.cost, 'EXECUTED', 1]
    )
  } catch (err) {
    logger.error('Failed to execute take profit', { coin, error: (err as Error).message })
  }
})

async function tradingLoop() {
  logger.info('Trading loop started')

  const settings = getSettings()
  const symbols = [...settings.watchlist]

  if (symbols.length === 0) {
    const topPairs = await getTopPairs(3)
    symbols.push(...topPairs)
  }

  const marketData = await fetchMarketData(symbols)
  const balance = await fetchBalance()

  checkOpenPositions()

  const portfolioState = computePortfolioState(balance, marketData, settings)

  for (const data of marketData) {
    const cycleId = `${Date.now().toString(36)}-${(++cycleCounter).toString(36)}`
    try {
      logPipelineEvent('research_started', data.symbol, cycleId, { symbol: data.symbol })
      const rawResearch = await researchCoin(data.symbol)
      logPipelineEvent('research_completed', data.symbol, cycleId, {
        symbol: data.symbol, headlines: rawResearch.headlines,
        articles: rawResearch.articles, sentiment: rawResearch.sentiment, summary: rawResearch.summary,
      })

      logPipelineEvent('extraction_started', data.symbol, cycleId, { symbol: data.symbol, articleCount: rawResearch.articles.length })
      const extractedResearch = await extractResearch(rawResearch)
      logPipelineEvent('extraction_completed', data.symbol, cycleId, {
        symbol: data.symbol, articles: extractedResearch.articles,
        aggregated_sentiment: extractedResearch.aggregated_sentiment, top_headlines: extractedResearch.top_headlines,
      })

      const marketCtx = await getMarketContext(data.symbol, data.price)
      logPipelineEvent('analysis_started', data.symbol, cycleId, {
        symbol: data.symbol, price: data.price, change24h: data.change24h, volume: data.volume,
        rsi14: marketCtx.rsi14, trend: marketCtx.trend, atr14: marketCtx.atr14,
      })

      const signal = await analyzeSignal(data.symbol, marketCtx, portfolioState, extractedResearch)

      logPipelineEvent('signal_generated', data.symbol, cycleId, {
        symbol: data.symbol, action: signal.action, reason: signal.reason, confidence: signal.confidence,
      })

      if (signal.action === 'HOLD' || signal.confidence < settings.min_confidence) {
        logger.debug('Skipping trade', { coin: data.symbol, action: signal.action, confidence: signal.confidence })
        continue
      }

      if (signal.action === 'BUY') {
        const openPositions = portfolioState.openPositionCount
        if (openPositions >= portfolioState.maxOpenPositions) {
          logger.warn('Max open positions reached, skipping BUY', { coin: data.symbol, openPositions })
          continue
        }

        const qty = calculatePositionSize(data.price, marketCtx.atr14, signal.confidence, portfolioState.totalValueUsd, settings)
        if (qty <= 0) continue

        const buySignal: Signal = { ...signal, quantity: qty }
        await handleTradeSignal(buySignal, data.price, marketCtx.atr14, settings)
      } else if (signal.action === 'SELL') {
        const existing = queryOne("SELECT * FROM positions WHERE coin = ? AND status = 'OPEN'", [data.symbol])
        if (existing) {
          const sellSignal: Signal = { ...signal, quantity: (existing.quantity as number) }
          await handleTradeSignal(sellSignal, data.price)
          runSQL(
            "UPDATE positions SET status = 'CLOSED', exit_id = (SELECT id FROM trades WHERE coin = ? ORDER BY id DESC LIMIT 1), pnl = (? * (? - entry_price)) WHERE id = ?",
            [data.symbol, existing.quantity, data.price, existing.id]
          )
        } else {
          logger.debug('No open position to sell', { coin: data.symbol })
        }
      }
    } catch (err) {
      logPipelineEvent('pipeline_error', data.symbol, cycleId, {
        symbol: data.symbol, error: (err as Error).message,
        price: data.price, change24h: data.change24h, volume: data.volume,
      })
      logger.error('Error in trading loop', { coin: data.symbol, error: (err as Error).message })
    }
  }

  const snapshotBalance = await fetchBalance()
  let totalValue = 0
  for (const data of marketData) {
    const coin = data.symbol.replace('/USDT', '')
    if (snapshotBalance[coin]) totalValue += snapshotBalance[coin].total * data.price
  }
  if (snapshotBalance['USDT']) totalValue += snapshotBalance['USDT'].total

  runSQL(
    'INSERT INTO portfolio_snapshots (total_value_usd, holdings) VALUES (?, ?)',
    [totalValue, JSON.stringify(Object.fromEntries(Object.entries(snapshotBalance).map(([k, v]) => [k, v.total])))]
  )

  bus.emit('portfolio_updated')
  logger.info('Trading loop completed', { totalValue })
}

async function handleTradeSignal(signal: Signal, price: number, atr?: number, settings?: any) {
  if (signal.action === 'HOLD') return

  const s = getSettings()

  if (s.approval_required || config.approvalsEnabled) {
    const total = price * signal.quantity
    const info = runSQL(
      "INSERT INTO trades (coin, side, quantity, price, total, status) VALUES (?, ?, ?, ?, ?, 'PENDING')",
      [signal.coin, signal.action, signal.quantity, price, total]
    )

    const tradeId = info.lastInsertRowid
    const req: ApprovalRequest = {
      tradeId,
      coin: signal.coin,
      side: signal.action,
      quantity: signal.quantity,
      estimatedPrice: price,
      reason: signal.reason,
      confidence: signal.confidence,
      expiresAt: new Date(Date.now() + config.approvalTimeoutMs).toISOString(),
    }

    pendingApprovals.set(tradeId, signal)
    bus.emit('approval_requested', req)
    sendApprovalMessage(req)

    const timer = setTimeout(() => {
      bus.emit('trade_rejected', tradeId)
      pendingApprovals.delete(tradeId)
      approvalTimers.delete(tradeId)
    }, config.approvalTimeoutMs)
    approvalTimers.set(tradeId, timer)
  } else {
    await submitTrade(signal, undefined, atr, s)
  }
}

async function submitTrade(signal: Signal, tradeId?: number, atr?: number, settings?: any) {
  try {
    const result = await executeTrade(signal)

    if (tradeId) {
      runSQL(
        "UPDATE trades SET price = ?, total = ?, status = 'EXECUTED', approved = 1 WHERE id = ?",
        [result.price, result.cost, tradeId]
      )
    } else {
      runSQL(
        'INSERT INTO trades (coin, side, quantity, price, total, status, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [signal.coin, signal.action, signal.quantity, result.price, result.cost, 'EXECUTED', 1]
      )
    }

    if (signal.action === 'BUY' && atr && settings) {
      const sl = calculateStopLoss(result.price, atr, settings)
      const tp = calculateTakeProfit(result.price, atr, settings)
      const oldPositions = queryOne("SELECT id FROM positions WHERE coin = ? AND status = 'OPEN'", [signal.coin])
      if (!oldPositions) {
        runSQL(
          'INSERT INTO positions (coin, side, quantity, entry_price, stop_loss, take_profit, current_sl) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [signal.coin, 'BUY', result.amount || signal.quantity, result.price, sl, tp, sl]
        )
        logger.info('Position opened', { coin: signal.coin, price: result.price, sl, tp })
      }
    }

    const trade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1')
    bus.emit('trade_executed', trade as any)
    logger.info('Trade executed', { coin: signal.coin, action: signal.action, price: result.price })
  } catch (err) {
    logger.error('Trade failed', { coin: signal.coin, error: (err as Error).message })
  }
}

bus.on('trade_approved', (tradeId: number) => {
  const signal = pendingApprovals.get(tradeId)
  if (!signal) return
  const timer = approvalTimers.get(tradeId)
  if (timer) clearTimeout(timer)
  approvalTimers.delete(tradeId)
  pendingApprovals.delete(tradeId)
  submitTrade(signal, tradeId)
})

bus.on('trade_rejected', (tradeId: number) => {
  const timer = approvalTimers.get(tradeId)
  if (timer) clearTimeout(timer)
  approvalTimers.delete(tradeId)
  pendingApprovals.delete(tradeId)
  runSQL("UPDATE trades SET approved = 0, status = 'FAILED' WHERE id = ? AND status = 'PENDING'", [tradeId])
  logger.info('Trade rejected by user', { tradeId })
})

async function start() {
  logger.info('Starting CryptoBot...')
  await initDB()
  startAPI()
  startTelegramBot()

  const settings = getSettings()
  const intervalMs = settings.interval_minutes * 60 * 1000

  tradingLoop()
  setInterval(tradingLoop, intervalMs)

  logger.info(`CryptoBot running. Loop every ${settings.interval_minutes} minutes.`)
}

start()
```

- [ ] **Step 2: Run type check**

```bash
cd /home/dauresl/cryptoBot/backend && npx tsc --noEmit
```
Expected: No errors. Fix any type issues that arise.

- [ ] **Step 3: Commit**

```bash
cd /home/dauresl/cryptoBot && git add backend/src/index.ts backend/src/core/events.ts backend/src/trader/index.ts && git commit -m "feat: integrate portfolio manager with risk management and position tracking"
```

---

### Task 7: Update frontend Settings page

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`

- [ ] **Step 1: Add risk config fields**

In `frontend/src/pages/Settings.tsx`, add risk management fields after the existing fields:

```tsx
<div className="border-t border-gray-800 pt-4 mt-4">
  <h3 className="text-sm font-semibold text-gray-300 mb-3">Risk Management</h3>
  <div className="space-y-4">
    <div>
      <label className="block text-sm text-gray-400 mb-1">Stop Loss (ATR multiplier)</label>
      <input type="number" step="0.5" min="1" max="10"
        className="w-full bg-gray-800 rounded px-3 py-2 text-sm"
        value={settings.stop_loss_atr || 2}
        onChange={(e) => setSettings({ ...settings, stop_loss_atr: parseFloat(e.target.value) })} />
    </div>
    <div>
      <label className="block text-sm text-gray-400 mb-1">Take Profit (ATR multiplier)</label>
      <input type="number" step="0.5" min="1" max="20"
        className="w-full bg-gray-800 rounded px-3 py-2 text-sm"
        value={settings.take_profit_atr || 4}
        onChange={(e) => setSettings({ ...settings, take_profit_atr: parseFloat(e.target.value) })} />
    </div>
    <div>
      <label className="block text-sm text-gray-400 mb-1">Max Risk Per Trade (%)</label>
      <input type="number" step="0.5" min="0.5" max="10"
        className="w-full bg-gray-800 rounded px-3 py-2 text-sm"
        value={(settings.max_risk_per_trade || 2) * 100}
        onChange={(e) => setSettings({ ...settings, max_risk_per_trade: parseFloat(e.target.value) / 100 })} />
    </div>
    <div>
      <label className="block text-sm text-gray-400 mb-1">Max Open Positions</label>
      <input type="number" step="1" min="1" max="20"
        className="w-full bg-gray-800 rounded px-3 py-2 text-sm"
        value={settings.max_open_positions || 5}
        onChange={(e) => setSettings({ ...settings, max_open_positions: parseInt(e.target.value) })} />
    </div>
  </div>
</div>
```

Also update the Settings interface to include the new fields:

```typescript
interface Settings {
  watchlist: string[]
  interval_minutes: number
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
  stop_loss_atr: number
  take_profit_atr: number
  max_risk_per_trade: number
  max_open_positions: number
}
```

- [ ] **Step 2: Run frontend type check**

```bash
cd /home/dauresl/cryptoBot/frontend && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /home/dauresl/cryptoBot && git add frontend/src/pages/Settings.tsx && git commit -m "feat: add risk management settings to frontend"
```
