# Critical & Medium Issue Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical and medium severity issues in the CryptoBot codebase to ensure safe, stable operation.

**Architecture:** Group fixes by phase — critical safety → backend stability → API validation → correctness → frontend → cleanup → infrastructure. Each phase is independent and can be executed in parallel via subagents.

**Tech Stack:** Node.js 22, TypeScript, SQLite (sql.js), Express, React + Vite, Puppeteer, ccxt, telegraf

---

## Phase 0 — Critical Fixes

### Task C1: Revoke & rotate Telegram token + add to `.env.example`

**Files:**
- Modify: `.env` (user action — revoke at BotFather, update with new token)
- Modify: `backend/.env.example` — add `TELEGRAM_BOT_TOKEN=` placeholder

- [ ] Add `TELEGRAM_BOT_TOKEN=` to `.env.example`

### Task C2: Fix SL/TP handlers use `quantity: 0`

**Files:**
- Modify: `backend/src/index.ts:252-268` (stop_loss_hit handler)
- Modify: `backend/src/index.ts:271-288` (take_profit_hit handler)

- [ ] In stop_loss_hit handler, before building signal, query position quantity:
```ts
const pos = queryOne("SELECT quantity FROM positions WHERE id = ?", [positionId])
const qty = pos ? (pos.quantity as number) : 0
const signal: Signal = { coin, action: 'SELL', quantity: qty, reason: 'Stop loss', confidence: 1 }
```

- [ ] Apply same fix in take_profit_hit handler

- [ ] Commit

## Phase 1 — Backend Stability

### Task S1: Fix `setInterval` overlapping loops

**Files:**
- Modify: `backend/src/index.ts:290-303`

- [ ] Replace `tradingLoop()` + `setInterval(tradingLoop, intervalMs)` with async loop:
```ts
async function runLoop() {
  while (true) {
    await tradingLoop()
    await new Promise(r => setTimeout(r, intervalMs))
  }
}
runLoop()
```

- [ ] Store interval reference for shutdown cleanup

- [ ] Commit

### Task S2: Debounce `saveDB()` calls

**Files:**
- Modify: `backend/src/db/index.ts`

- [ ] Remove `saveDB()` from `runSQL()`. Add debounced periodic save:
```ts
let savePending = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleSave(): void {
  if (savePending) return
  savePending = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveDB(); savePending = false; saveTimer = null }, 1000)
}
```

- [ ] Replace `saveDB()` call in `runSQL()` with `scheduleSave()`

- [ ] Call `saveDB()` directly in shutdown handler

- [ ] Commit

### Task S3: Add graceful shutdown

**Files:**
- Modify: `backend/src/index.ts`
- Modify: `backend/src/api/index.ts` (export server reference)
- Modify: `backend/src/api/ws.ts` (export wss reference)
- Modify: `backend/src/scraper/browser.js` (already has closeBrowser)

- [ ] Export server from api/index.ts and wss from ws.ts
- [ ] Add shutdown handler:
```ts
async function shutdown(signal: string) {
  logger.info(`Shutting down on ${signal}`)
  await closeBrowser()
  await bot?.stop('keyboard')
  saveDB()
  wss?.close()
  server?.close()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
```

- [ ] Commit

### Task S4: Puppeteer browser close on shutdown

**Files:** Already handled by S3 (closeBrowser is called in shutdown)

### Task S5: Add Express error-handling middleware

**Files:**
- Modify: `backend/src/api/index.ts`

- [ ] Add after `app.use('/api', router)`:
```ts
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', { error: err.message })
  res.status(500).json({ error: err.message })
})
```

- [ ] Commit

### Task S6: Fix `runSQL` error handling + `queryAll` stmt leak

**Files:**
- Modify: `backend/src/db/index.ts`

- [ ] Wrap `runSQL` params path in try/finally for `stmt.free()`:
```ts
if (params) {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(params as any)
    stmt.step()
  } finally {
    stmt.free()
  }
}
```

- [ ] Wrap `queryAll` params path in try/finally for `stmt.free()`:
```ts
if (params) {
  const stmt = db.prepare(sql)
  stmt.bind(params as any)
  const rows: Record<string, unknown>[] = []
  try {
    while (stmt.step()) { rows.push(stmt.getAsObject()) }
  } finally {
    stmt.free()
  }
  return rows
}
```

- [ ] Commit

### Task S7: Fix `num()` helper returning NaN

**Files:**
- Modify: `backend/src/config/index.ts`

- [ ] Fix `num()` to return default on NaN:
```ts
function num(key: string, def: number): number {
  const val = process.env[key]
  if (!val) return def
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? def : parsed
}
```

- [ ] Commit

## Phase 2 — API & Input Validation

### Task V1: Validate `/trade/manual` input

**Files:**
- Modify: `backend/src/api/routes.ts:131-144`

- [ ] Add validation:
```ts
router.post('/trade/manual', async (req: Request, res: Response) => {
  const { coin, side, quantity } = req.body
  if (!coin || !['BUY', 'SELL'].includes(side) || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'Invalid input: coin, side (BUY/SELL), quantity (>0) required' })
  }
  // ... rest unchanged
})
```

- [ ] Commit

### Task V2: Validate approve/reject trade exists

**Files:**
- Modify: `backend/src/api/routes.ts:119-129`

- [ ] Add validation:
```ts
router.post('/trade/approve/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const trade = queryOne("SELECT id FROM trades WHERE id = ? AND status = 'PENDING'", [id])
  if (!trade) return res.status(404).json({ error: 'Trade not found or not pending' })
  bus.emit('trade_approved', id)
  res.json({ ok: true })
})
```

- [ ] Apply same to reject route

- [ ] Commit

### Task V3: Add rate limiting

**Files:**
- Modify: `backend/src/api/index.ts`
- Modify: `backend/package.json` (add express-rate-limit)

- [ ] `npm install express-rate-limit`
- [ ] Add middleware:
```ts
import rateLimit from 'express-rate-limit'
const limiter = rateLimit({ windowMs: 60_000, max: 100 })
app.use('/api', limiter)
```

- [ ] Commit

### Task V4: Use config for `TELEGRAM_CHAT_ID`

**Files:**
- Modify: `backend/src/config/index.ts` — add `chatId: opt('TELEGRAM_CHAT_ID', '')`
- Modify: `backend/src/telegram/bot.ts:50` — use `config.telegram.chatId`

- [ ] Commit

## Phase 3 — Correctness Bugs

### Task B1: Fix `createMarketBuyOrder` amount semantics

**Files:**
- Modify: `backend/src/trader/service.ts:58-60`

- [ ] For BUY orders, convert amount to base coin:
```ts
if (signal.action === 'BUY') {
  const ticker = await ex.fetchTicker(symbol)
  const baseAmount = signal.quantity / (ticker.last || 1)
  const order = await ex.createMarketBuyOrder(symbol, baseAmount)
  return { id: order.id, price: order.price, quantity: order.amount, cost: order.cost }
}
```

- [ ] Commit

### Task B2: Fix watchlist corruption in Settings.tsx

**Files:**
- Modify: `frontend/src/pages/Settings.tsx:46`

- [ ] Only append `/USDT` if not already present:
```ts
onChange={(e) => setSettings({
  ...settings,
  watchlist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.endsWith('/USDT') ? s : s + '/USDT')
})}
```

- [ ] Commit

### Task B3: Fix stale closure in `useWebSocket`

**Files:**
- Modify: `frontend/src/hooks/useWebSocket.ts`

- [ ] Use ref for onMessage to avoid stale closure:
```ts
const onMessageRef = useRef(onMessage)
onMessageRef.current = onMessage

ws.current.onmessage = (event) => {
  try {
    const msg = JSON.parse(event.data) as WsMessage
    onMessageRef.current?.(msg)
  } catch { /* ignore malformed */ }
}
```

- [ ] Commit

### Task B4: Fix `fetchBalance` filtering valid coins

**Files:**
- Modify: `backend/src/trader/service.ts:39-49`

- [ ] Include all coins including zero-balance:
```ts
for (const [coin] of Object.entries(bal.total)) {
  result[coin] = {
    total: Number((bal.total as any)[coin]) || 0,
    free: Number((bal.free as any)[coin]) || 0,
    used: Number((bal.used as any)[coin]) || 0,
  }
}
```

- [ ] Commit

### Task B5: Fix `DEFAULT_CHANGE` static value in stub

**Files:**
- Modify: `backend/src/trader/stub.ts:29`

- [ ] Remove `DEFAULT_CHANGE` constant, compute per-coin:
```ts
change24h: Math.random() * 10 - 5,
```

- [ ] Commit

### Task B6: Fix `(err as Error).message` pattern

**Files:** Multiple files — `index.ts`, `routes.ts`, `market.ts`, etc.

- [ ] Replace all `(err as Error).message` with `err instanceof Error ? err.message : String(err)`

- [ ] Commit

## Phase 4 — Real-Time & Frontend

### Task R1: WebSocket auto-reconnect in frontend

**Files:**
- Modify: `frontend/src/hooks/useWebSocket.ts`

- [ ] Add exponential backoff reconnect on `onclose`:
```ts
useEffect(() => {
  let reconnectTimer: ReturnType<typeof setTimeout>
  let retries = 0

  function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/ws`
    const socket = new WebSocket(url)
    ws.current = socket

    socket.onopen = () => { retries = 0; setConnected(true) }
    socket.onclose = () => {
      setConnected(false)
      const delay = Math.min(1000 * Math.pow(2, retries), 30000)
      retries++
      reconnectTimer = setTimeout(connect, delay)
    }
    socket.onerror = () => setConnected(false)

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage
        onMessageRef.current?.(msg)
      } catch { /* ignore */ }
    }
  }
  connect()
  return () => { clearTimeout(reconnectTimer); ws.current?.close() }
}, [])
```

- [ ] Commit

### Task R2: Fix array index as React key

**Files:**
- Modify: `frontend/src/pages/Logs.tsx:65`

- [ ] Change `key={i}` to unique key using entry.id or entry.ts:
```ts
key={`${entry.ts}-${(entry.data as any).id || i}`}
```

- [ ] Commit

### Task R3: Fix settings save error handling

**Files:**
- Modify: `frontend/src/pages/Settings.tsx:23-31`

- [ ] Wrap save in try/catch/finally:
```ts
const save = async (e: FormEvent) => {
  e.preventDefault()
  setSaving(true)
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
    if (!res.ok) throw new Error('Save failed')
  } catch { /* show error */ }
  finally { setSaving(false) }
}
```

- [ ] Commit

### Task R4: Fix `parseInt('')` → NaN on number inputs

**Files:**
- Modify: `frontend/src/pages/Settings.tsx:51,59,80`

- [ ] Replace `parseInt(e.target.value)` with `parseInt(e.target.value) || 0`

- [ ] Commit

## Phase 5 — Cleanup & Debt

### Task D1: Remove dead `analyst/prompts.ts`

- [ ] Delete `backend/src/analyst/prompts.ts`
- [ ] Commit

### Task D2: Remove unused schema columns

**Files:**
- Modify: `backend/src/db/schema.ts`

- [ ] Remove `signal_id` from trades, `entry_id`/`exit_id` from positions, `triggered_trade_id` from decisions

- [ ] Commit

### Task D3: Remove dead `scraper/utils/output.js`

- [ ] Delete `backend/src/scraper/utils/output.js`
- [ ] Commit

### Task D4: Fix `warn()` to stderr

**Files:**
- Modify: `backend/src/core/logger.ts`

- [ ] Change `process.stdout.write` to `process.stderr.write` for warn/error levels

- [ ] Commit

### Task D5: Add DB indexes

**Files:**
- Modify: `backend/src/db/schema.ts`

- [ ] Add indexes:
```sql
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_created ON portfolio_snapshots(created_at);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_created ON pipeline_events(created_at);
```

- [ ] Commit

## Phase 6 — Infrastructure

### Task I1: Fix `start` script (ts-node → tsx)

**Files:**
- Modify: `backend/package.json:8`

- [ ] Change `"start": "node --loader ts-node/esm src/index.ts"` to `"start": "tsx src/index.ts"`

- [ ] Commit

### Task I2: Fix Vite proxy for local dev

**Files:**
- Modify: `frontend/vite.config.ts`

- [ ] Add fallback for non-Docker:
```ts
proxy: {
  '/api': { target: process.env.VITE_API_URL || 'http://backend:3000', changeOrigin: true },
  '/ws': { target: process.env.VITE_WS_URL || 'ws://backend:3000', ws: true },
}
```

- [ ] Commit

### Task I3: Cache ccxt exchange singleton

**Files:**
- Modify: `backend/src/trader/service.ts` — export `getExchange`
- Modify: `backend/src/portfolio/market.ts:46-47` — use imported exchange
- Modify: `backend/src/api/routes.ts:27-28` — use imported exchange
- Modify: `backend/src/portfolio/index.ts:26-27` — use imported exchange

- [ ] Export `getExchange` from `trader/service.ts`
- [ ] Replace all `new ccxt.binance()` in other modules with imported `getExchange()`

- [ ] Commit

---
