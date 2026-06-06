# Local Portfolio Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Binance balance-based portfolio with a local `portfolio_entries` table that tracks bought coins with buy_price, buy_date, and computes deltas.

**Architecture:** New `portfolio_entries` table as source of truth for holdings. Auto-populated from executed BUY trades. PortfolioState computed from local entries + current prices + USDT balance (Binance). Delta (current - buy price) shown per entry.

**Tech Stack:** SQLite (sql.js), Node.js/TypeScript, React, ccxt (Binance)

---

### Task 1: Add PortfolioEntry type and update PortfolioState

**Files:**
- Modify: `backend/src/types.ts`

- [ ] **Step 1: Add PortfolioEntry and update PortfolioState**

Add to `backend/src/types.ts`:

```typescript
export interface PortfolioEntry {
  id: number
  coin: string
  quantity: number
  buy_price: number
  buy_date: string
  status: 'OPEN' | 'CLOSED'
  source: 'trade' | 'manual'
  trade_id: number | null
  current_price: number | null
  delta_usd: number | null
  delta_pct: number | null
  created_at: string
}
```

Replace `PortfolioState.positions` type from `{ coin: string; allocationPct: number; pnlPct: number }[]` to include delta info:

```typescript
export interface PortfolioState {
  totalValueUsd: number
  positions: { coin: string; allocationPct: number; deltaPct: number; entryPrice: number; currentPrice: number; quantity: number }[]
  diversificationScore: number
  openPositionCount: number
  maxOpenPositions: number
  targetAllocationPct: number
}
```

- [ ] **Step 2: Verify no type errors**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors (or only expected pre-existing ones unrelated to these types)

- [ ] **Step 3: Commit**

```bash
git add backend/src/types.ts
git commit -m "feat: add PortfolioEntry type, update PortfolioState with delta fields"
```

---

### Task 2: Add portfolio_entries table to schema

**Files:**
- Modify: `backend/src/db/schema.ts`

- [ ] **Step 1: Add portfolio_entries CREATE TABLE**

Append before the final closing backtick of SCHEMA:

```typescript
CREATE TABLE IF NOT EXISTS portfolio_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  coin        TEXT NOT NULL,
  quantity    REAL NOT NULL,
  buy_price   REAL NOT NULL,
  buy_date    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
  source      TEXT NOT NULL DEFAULT 'trade' CHECK(source IN ('trade','manual')),
  trade_id    INTEGER REFERENCES trades(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Add index:

```typescript
CREATE INDEX IF NOT EXISTS idx_portfolio_entries_status ON portfolio_entries(status);
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/db/schema.ts
git commit -m "feat: add portfolio_entries table to DB schema"
```

---

### Task 3: Create portfolio service (CRUD + getPortfolioState)

**Files:**
- Create: `backend/src/portfolio/service.ts`

- [ ] **Step 1: Create service.ts with CRUD and state computation**

Create `backend/src/portfolio/service.ts`:

```typescript
import { queryAll, queryOne, runSQL, getSettings } from '../db/index.js'
import { logger } from '../core/logger.js'
import { MarketData, PortfolioEntry, PortfolioState, BotSettings } from '../types.js'

export function getOpenEntries(): PortfolioEntry[] {
  return queryAll("SELECT * FROM portfolio_entries WHERE status = 'OPEN' ORDER BY created_at ASC") as unknown as PortfolioEntry[]
}

export function getAllEntries(): PortfolioEntry[] {
  return queryAll("SELECT * FROM portfolio_entries ORDER BY created_at DESC") as unknown as PortfolioEntry[]
}

export function getEntryById(id: number): PortfolioEntry | null {
  return queryOne("SELECT * FROM portfolio_entries WHERE id = ?", [id]) as PortfolioEntry | null
}

export function addEntry(
  coin: string,
  quantity: number,
  buyPrice: number,
  buyDate: string,
  source: 'trade' | 'manual' = 'trade',
  tradeId?: number,
): number {
  const { lastInsertRowid } = runSQL(
    `INSERT INTO portfolio_entries (coin, quantity, buy_price, buy_date, source, trade_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [coin, quantity, buyPrice, buyDate, source, tradeId ?? null]
  )
  logger.info('Portfolio entry added', { coin, quantity, buyPrice, id: lastInsertRowid })
  return lastInsertRowid
}

export function closeEntry(id: number): void {
  runSQL("UPDATE portfolio_entries SET status = 'CLOSED' WHERE id = ? AND status = 'OPEN'", [id])
  const entry = getEntryById(id)
  if (entry) {
    logger.info('Portfolio entry closed', { coin: entry.coin, id })
  }
}

export function reduceEntryQuantity(id: number, sellQty: number): void {
  const entry = getEntryById(id)
  if (!entry) return
  const newQty = entry.quantity - sellQty
  if (newQty <= 0) {
    closeEntry(id)
  } else {
    runSQL("UPDATE portfolio_entries SET quantity = ? WHERE id = ?", [newQty, id])
  }
}

export function removeEntry(id: number): void {
  runSQL("DELETE FROM portfolio_entries WHERE id = ?", [id])
}

export function updateEntryQuantity(id: number, quantity: number): void {
  runSQL("UPDATE portfolio_entries SET quantity = ? WHERE id = ?", [quantity, id])
}

export function updateEntry(id: number, updates: Partial<Pick<PortfolioEntry, 'quantity' | 'buy_price' | 'buy_date'>>): void {
  const setClauses: string[] = []
  const params: (string | number)[] = []
  if (updates.quantity !== undefined) {
    setClauses.push('quantity = ?')
    params.push(updates.quantity)
  }
  if (updates.buy_price !== undefined) {
    setClauses.push('buy_price = ?')
    params.push(updates.buy_price)
  }
  if (updates.buy_date !== undefined) {
    setClauses.push('buy_date = ?')
    params.push(updates.buy_date)
  }
  if (setClauses.length === 0) return
  params.push(id)
  runSQL(`UPDATE portfolio_entries SET ${setClauses.join(', ')} WHERE id = ?`, params)
}

export function getPortfolioState(
  marketData: MarketData[],
  usdtBalance: number,
  settings: BotSettings,
): PortfolioState {
  const entries = getOpenEntries()
  const coinValues: Record<string, number> = {}
  let totalValue = usdtBalance

  for (const entry of entries) {
    const md = marketData.find(d => d.symbol === entry.coin)
    if (md) {
      const val = entry.quantity * md.price
      coinValues[entry.coin] = val
      totalValue += val
    }
  }

  const positions = entries.map(e => {
    const md = marketData.find(d => d.symbol === e.coin)
    const currentPrice = md?.price || e.buy_price
    const currentValue = e.quantity * currentPrice
    const allocationPct = totalValue > 0 ? currentValue / totalValue : 0
    const deltaPct = e.buy_price > 0 ? ((currentPrice - e.buy_price) / e.buy_price) * 100 : 0
    return {
      coin: e.coin,
      allocationPct,
      deltaPct,
      entryPrice: e.buy_price,
      currentPrice,
      quantity: e.quantity,
    }
  })

  const coinCount = positions.length + 1 // +1 for USDT
  const targetAllocationPct = coinCount > 0 ? 1 / coinCount : 1

  const allocs = positions.map(p => p.allocationPct)
  const idealAlloc = 1 / coinCount
  const deviations = allocs.map(a => Math.abs(a - idealAlloc))
  const avgDeviation = deviations.length > 0 ? deviations.reduce((s, d) => s + d, 0) / deviations.length : 0
  const diversificationScore = Math.max(0, 1 - avgDeviation)

  return {
    totalValueUsd: totalValue,
    positions,
    diversificationScore,
    openPositionCount: positions.length,
    maxOpenPositions: settings.max_open_positions,
    targetAllocationPct,
  }
}

export function enrichPortfolioEntriesWithPrices(
  entries: PortfolioEntry[],
  marketData: MarketData[],
): PortfolioEntry[] {
  return entries.map(e => {
    const md = marketData.find(d => d.symbol === e.coin)
    const currentPrice = md?.price ?? null
    const deltaUsd = currentPrice !== null && e.buy_price > 0
      ? (currentPrice - e.buy_price) * e.quantity
      : null
    const deltaPct = currentPrice !== null && e.buy_price > 0
      ? ((currentPrice - e.buy_price) / e.buy_price) * 100
      : null
    return {
      ...e,
      current_price: currentPrice,
      delta_usd: deltaUsd !== null ? Math.round(deltaUsd * 100) / 100 : null,
      delta_pct: deltaPct !== null ? Math.round(deltaPct * 100) / 100 : null,
    }
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/portfolio/service.ts
git commit -m "feat: create portfolio service with CRUD and state computation"
```

---

### Task 4: Update portfolio/index.ts exports

**Files:**
- Modify: `backend/src/portfolio/index.ts`

- [ ] **Step 1: Rewrite index.ts to export new service and remove old computePortfolioState**

Replace `backend/src/portfolio/index.ts`:

```typescript
import { queryAll } from '../db/index.js'
import { PositionRecord } from '../types.js'

export function getOpenPositions(): PositionRecord[] {
  return queryAll("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY created_at ASC") as unknown[] as PositionRecord[]
}

export {
  getOpenEntries,
  getAllEntries,
  getEntryById,
  addEntry,
  closeEntry,
  reduceEntryQuantity,
  removeEntry,
  updateEntryQuantity,
  updateEntry,
  getPortfolioState,
  enrichPortfolioEntriesWithPrices,
} from './service.js'

export { getMarketContext } from './market.js'
export { buildAnalysisPrompt } from './prompts.js'
export {
  calculatePositionSize,
  calculateStopLoss,
  calculateTakeProfit,
  checkPosition,
} from './risk.js'
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/portfolio/index.ts
git commit -m "feat: update portfolio exports to use new service"
```

---

### Task 5: Update portfolio prompts to show delta info

**Files:**
- Modify: `backend/src/portfolio/prompts.ts`

- [ ] **Step 1: Update buildAnalysisPrompt to use new position shape**

Change the `positionsList` mapping in `buildAnalysisPrompt`:

```typescript
const positionsList = portfolio.positions.length === 0
  ? 'None'
  : portfolio.positions.map(p => {
      const deltaSign = p.deltaPct > 0 ? '+' : ''
      return `- ${p.coin}: ${(p.allocationPct * 100).toFixed(1)}% of portfolio, bought at $${p.entryPrice.toFixed(2)}, now $${p.currentPrice.toFixed(2)}, delta: ${deltaSign}${p.deltaPct.toFixed(1)}%`
    }).join('\n')
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/portfolio/prompts.ts
git commit -m "feat: show delta info in LLM portfolio prompt"
```

---

### Task 6: Update trading loop to use local portfolio

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Update imports**

Replace:
```typescript
import { getMarketContext, checkOpenPositions, computePortfolioState } from './portfolio/index.js'
import { calculatePositionSize, calculateStopLoss, calculateTakeProfit } from './portfolio/risk.js'
```

With:
```typescript
import { getMarketContext, checkOpenPositions, getPortfolioState, addEntry, closeEntry, reduceEntryQuantity, enrichPortfolioEntriesWithPrices, getOpenPositions, calculatePositionSize, calculateStopLoss, calculateTakeProfit } from './portfolio/index.js'
```

- [ ] **Step 2: Replace fetchBalance in trading loop**

In the `tradingLoop()` function, replace:
```typescript
const balance = await fetchBalance()
```

With (keep the import but only use it for USDT):
```typescript
const { fetchBalance } = await import('./trader/index.js')
const balance = await fetchBalance()
const usdtBalance = balance['USDT']?.total || 0
```

Replace:
```typescript
const portfolioState = computePortfolioState(balance, marketData, settings)
```

With:
```typescript
const portfolioState = getPortfolioState(marketData, usdtBalance, settings)
```

- [ ] **Step 3: Auto-add portfolio entry on BUY execution**

In `submitTrade()`, change the trade var to get the id, then after the position insert block add:

```typescript
const trade = queryOne('SELECT * FROM trades ORDER BY id DESC LIMIT 1') as Record<string, unknown> | null
bus.emit('trade_executed', trade as any)

if (signal.action === 'BUY') {
  addEntry(signal.coin, result.quantity, result.price, new Date().toISOString().split('T')[0], 'trade', (trade?.id as number) || (tradeId as number))
}
```

Don't forget to remove the old duplicate `const trade = queryOne(...)` and `bus.emit(...)` lines that already exist in the function — they should only appear once.

- [ ] **Step 4: Auto-close portfolio entry on SELL in trading loop**

In `tradingLoop()`, after the SELL position status update, add:

```typescript
const sellEntries = queryAll("SELECT id, quantity FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC", [data.symbol]) as { id: number; quantity: number }[]
for (const entry of sellEntries) {
  reduceEntryQuantity(entry.id, (existing.quantity as number))
}
```

- [ ] **Step 5: Close entries on SL/TP hit**

In the `stop_loss_hit` and `take_profit_hit` event handlers, after position update add:

```typescript
const slEntries = queryAll("SELECT id, quantity FROM portfolio_entries WHERE coin = ? AND status = 'OPEN' ORDER BY created_at ASC", [coin]) as { id: number; quantity: number }[]
for (const entry of slEntries) {
  closeEntry(entry.id)
}
```

- [ ] **Step 6: Update portfolio snapshot to use local entries**

Replace the snapshot block at end of `tradingLoop()`:

```typescript
const portfolioEntries = getOpenEntries()
let snapshotTotal = usdtBalance
const holdings: Record<string, number> = { USDT: usdtBalance }
for (const entry of portfolioEntries) {
  const md = marketData.find(d => d.symbol === entry.coin)
  if (md) {
    snapshotTotal += entry.quantity * md.price
    holdings[entry.coin] = entry.quantity
  }
}

runSQL(
  'INSERT INTO portfolio_snapshots (total_value_usd, holdings) VALUES (?, ?)',
  [snapshotTotal, JSON.stringify(holdings)]
)
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat: use local portfolio entries in trading loop"
```

---

### Task 7: Update API routes for local portfolio

**Files:**
- Modify: `backend/src/api/routes.ts`

- [ ] **Step 1: Update imports**

Add at top:
```typescript
import { getOpenEntries, getAllEntries, getEntryById, addEntry, updateEntry, removeEntry, enrichPortfolioEntriesWithPrices } from '../portfolio/index.js'
import { getExchange } from '../trader/service.js'
```

- [ ] **Step 2: Rewrite GET /api/portfolio**

Replace the `/portfolio` route:

```typescript
router.get('/portfolio', async (_req: Request, res: Response) => {
  try {
    const exchange = getExchange()
    const entries = getOpenEntries()
    const symbols = entries.map(e => e.coin)
    const tickers = symbols.length > 0 ? await exchange.fetchTickers(symbols) : {}

    const bal = await exchange.fetchBalance()
    const usdtBalance = (bal.total as Record<string, number>)['USDT'] || 0

    const marketData = symbols.map(s => ({
      symbol: s,
      price: (tickers[s] as any)?.last || 0,
      change24h: (tickers[s] as any)?.percentage || 0,
      volume: (tickers[s] as any)?.quoteVolume || 0,
    }))

    const enriched = enrichPortfolioEntriesWithPrices(entries, marketData)

    const totalValue = enriched.reduce((sum, e) => sum + ((e.current_price ?? 0) * e.quantity), 0) + usdtBalance

    res.json({
      total_value_usd: Math.round(totalValue * 100) / 100,
      entries: enriched,
      usdt_balance: usdtBalance,
      open_position_count: enriched.length,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
```

- [ ] **Step 3: Add POST /api/portfolio/entry**

```typescript
router.post('/portfolio/entry', (req: Request, res: Response) => {
  const { coin, quantity, buy_price, buy_date, source } = req.body
  if (!coin || typeof coin !== 'string') return res.status(400).json({ error: 'coin required' })
  if (typeof quantity !== 'number' || quantity <= 0) return res.status(400).json({ error: 'quantity must be positive number' })
  if (typeof buy_price !== 'number' || buy_price <= 0) return res.status(400).json({ error: 'buy_price must be positive number' })
  const date = buy_date || new Date().toISOString().split('T')[0]
  const id = addEntry(coin, quantity, buy_price, date, source || 'manual')
  res.json({ ok: true, id })
})
```

- [ ] **Step 4: Add PATCH /api/portfolio/entry/:id**

```typescript
router.patch('/portfolio/entry/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  const entry = getEntryById(id)
  if (!entry) return res.status(404).json({ error: 'Entry not found' })
  const { quantity, buy_price, buy_date } = req.body
  updateEntry(id, { quantity, buy_price, buy_date })
  res.json({ ok: true })
})
```

- [ ] **Step 5: Add DELETE /api/portfolio/entry/:id**

```typescript
router.delete('/portfolio/entry/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
  removeEntry(id)
  res.json({ ok: true })
})
```

- [ ] **Step 6: Add GET /api/portfolio/history**

```typescript
router.get('/portfolio/history', async (_req: Request, res: Response) => {
  try {
    const exchange = getExchange()
    const entries = getAllEntries()
    const symbols = [...new Set(entries.filter(e => e.status === 'OPEN').map(e => e.coin))]
    const tickers = symbols.length > 0 ? await exchange.fetchTickers(symbols) : {}
    const marketData = symbols.map(s => ({
      symbol: s,
      price: (tickers[s] as any)?.last || 0,
      change24h: 0,
      volume: 0,
    }))
    const enriched = enrichPortfolioEntriesWithPrices(entries, marketData)
    res.json(enriched)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/api/routes.ts
git commit -m "feat: update API routes for local portfolio with delta"
```

---

### Task 8: Update frontend Portfolio page

**Files:**
- Modify: `frontend/src/pages/Portfolio.tsx`

- [ ] **Step 1: Update PortfolioData interface**

Replace:
```typescript
interface PortfolioData {
  total_value_usd: number
  holdings: Record<string, number>
  open_position_count: number
  max_open_positions: number
}
```

With:
```typescript
interface PortfolioEntryUI {
  id: number
  coin: string
  quantity: number
  buy_price: number
  buy_date: string
  current_price: number | null
  delta_usd: number | null
  delta_pct: number | null
  status: string
}

interface PortfolioData {
  total_value_usd: number
  entries: PortfolioEntryUI[]
  usdt_balance: number
  open_position_count: number
}
```

- [ ] **Step 2: Update fetch logic**

Replace the `useEffect`:
```typescript
useEffect(() => {
  Promise.all([
    fetch('/api/portfolio').then(r => r.json()),
    fetch('/api/positions').then(r => r.json()),
  ]).then(([p, pos]) => {
    setPortfolio(p)
    setPositions(pos)
  }).catch(() => {}).finally(() => setLoading(false))
}, [])
```

With:
```typescript
useEffect(() => {
  fetch('/api/portfolio')
    .then(r => r.json())
    .then(p => {
      setPortfolio(p)
      setPositions(p.entries || [])
    })
    .catch(() => {})
    .finally(() => setLoading(false))
}, [])
```

- [ ] **Step 3: Update header cards**

Replace the holdings count card:
```typescript
<div className="bg-gray-900 rounded-lg p-4">
  <div className="text-gray-400 text-sm">USDT Balance</div>
  <div className="text-3xl font-bold text-white">${portfolio?.usdt_balance?.toFixed(2) || '0.00'}</div>
</div>
```

Keep total value and open positions cards as they are (the new response shape has them).

- [ ] **Step 4: Update table columns**

Replace the positions table to show portfolio entry columns:

```typescript
<table className="w-full text-sm">
  <thead>
    <tr className="text-gray-400 border-b border-gray-800">
      <th className="text-left py-2 pr-4">Coin</th>
      <th className="text-right py-2 pr-4">Qty</th>
      <th className="text-right py-2 pr-4">Buy Date</th>
      <th className="text-right py-2 pr-4">Buy Price</th>
      <th className="text-right py-2 pr-4">Current</th>
      <th className="text-right py-2 pr-4">Delta $</th>
      <th className="text-right py-2">Delta %</th>
    </tr>
  </thead>
  <tbody>
    {positions.map(p => {
      const isPositive = p.delta_pct !== null && p.delta_pct >= 0
      return (
        <tr key={p.id} className="border-b border-gray-800 hover:bg-gray-800/40">
          <td className="py-3 pr-4 font-medium">{p.coin}</td>
          <td className="text-right py-3 pr-4">{p.quantity}</td>
          <td className="text-right py-3 pr-4">{p.buy_date}</td>
          <td className="text-right py-3 pr-4">${p.buy_price.toFixed(2)}</td>
          <td className="text-right py-3 pr-4">{p.current_price ? `$${p.current_price.toFixed(2)}` : '—'}</td>
          <td className={`text-right py-3 pr-4 font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
            {p.delta_usd !== null ? `${p.delta_usd > 0 ? '+' : ''}$${p.delta_usd.toFixed(2)}` : '—'}
          </td>
          <td className={`text-right py-3 font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
            {p.delta_pct !== null ? `${p.delta_pct > 0 ? '+' : ''}${p.delta_pct.toFixed(2)}%` : '—'}
          </td>
        </tr>
      )
    })}
  </tbody>
</table>
```

- [ ] **Step 5: Replace holdings section**

Replace the whole holdings section with a USDT display:

```typescript
<div className="bg-gray-900 rounded-lg p-4">
  <h2 className="text-lg font-semibold mb-3">Cash</h2>
  <div className="flex justify-between items-center border-b border-gray-800 pb-2">
    <span className="font-medium">USDT</span>
    <span className="text-gray-300">${portfolio?.usdt_balance?.toFixed(2) || '0.00'}</span>
  </div>
</div>
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Portfolio.tsx
git commit -m "feat: update portfolio page with buy date, price, and delta columns"
```

---

### Task 9: Update frontend Dashboard to use new API shape

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Keep dashboard working**

The Dashboard only uses `total_value_usd`, `open_position_count`, and `max_open_positions` from `/api/portfolio`. The new response still includes these fields, so the dashboard should work without changes. Remove the `PortfolioData` local interface if duplicated.

[No code changes needed — verify it works]

- [ ] **Step 2: Build check**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

---

### Task 10: Verify build

**Files:**
- All modified files

- [ ] **Step 1: Run backend type check**

```bash
cd backend && npx tsc --noEmit 2>&1
```

Expected: No errors

- [ ] **Step 2: Run frontend type check**

```bash
cd frontend && npx tsc --noEmit 2>&1
```

Expected: No errors

- [ ] **Step 3: Run backend (quick smoke test)**

```bash
cd backend && timeout 10 npx tsx src/index.ts 2>&1 || true
```

Expected: Starts up, logs "Database initialized" and "CryptoBot running" (or hits timeout cleanly)
