# CryptoBot — Issues

## 🔴 Critical

### 1. Telegram bot token exposed in `.env`
**File:** `.env:16`

The file contains a real Telegram bot token (`6898276009:AAF9...`). Although `.env` is in `.gitignore`, the token has likely been committed to git history. **Action:** Revoke the token immediately and rotate it. Add a `.env.example` with placeholder values instead.

### 2. Stop-loss / take-profit handlers use `quantity: 0`
**File:** `backend/src/index.ts:252-268, 271-288`

When `stop_loss_hit` or `take_profit_hit` fires, the signal is created with `quantity: 0`:
```ts
const signal: Signal = { coin, action: 'SELL', quantity: 0, reason: 'Stop loss', confidence: 1 }
```
`executeTrade(signal)` will attempt to sell 0 coins, which will fail or do nothing. The handler must query the position to get the actual quantity to sell.

**Fix:** Look up the position quantity before building the signal:
```ts
const pos = queryOne("SELECT quantity FROM positions WHERE id = ?", [positionId])
const signal: Signal = { coin, action: 'SELL', quantity: pos.quantity, ... }
```

## 🟠 Medium

### 3. Two different `buildAnalysisPrompt` functions with different signatures
**Files:** `backend/src/analyst/prompts.ts`, `backend/src/portfolio/prompts.ts`

There are two `buildAnalysisPrompt` functions:
- `analyst/prompts.ts`: `(coin, price, change24h, volume, research, portfolioPercent)` — **dead code, never imported**
- `portfolio/prompts.ts`: `(coin, market, portfolio, settings, research)` — the one actually used

Remove `analyst/prompts.ts` entirely.

### 4. Multiple uncached ccxt exchange instances
**Files:** `backend/src/portfolio/market.ts:47`, `backend/src/portfolio/index.ts:27`, `backend/src/api/routes.ts:28`

Only `trader/service.ts` caches the exchange as a singleton. Other modules create new `ccxt.binance()` instances on every call:
- `getMarketContext()` — new instance per call
- `checkOpenPositions()` — new instance per position
- `/positions` endpoint — new instance per request

This wastes resources and risks hitting rate limits. **Fix:** Export the singleton exchange from `trader/service.ts` and reuse it.

### 5. No graceful shutdown / process cleanup
**File:** `backend/src/index.ts`

No `SIGTERM`/`SIGINT` handler. On process exit:
- SQLite DB may not be saved (buffered data lost)
- Puppeteer browser is never closed
- WebSocket connections are not properly closed
- Telegram bot is not stopped

**Fix:** Add signal handlers:
```ts
process.on('SIGTERM', async () => { saveDB(); await closeBrowser(); process.exit(0) })
```

### 6. Puppeteer browser never closed
**File:** `backend/src/scraper/browser.js`

The browser is lazily created but never closed, even on process exit. This leaks memory and the browser process.

### 7. No input validation on `/trade/manual` endpoint
**File:** `backend/src/api/routes.ts:131-144`

The endpoint accepts any `side` value, but the `trades` table has a CHECK constraint (`side IN ('BUY','SELL')`). Invalid values will cause a SQL error and return a 500.

**Fix:** Validate `side` is `'BUY'` or `'SELL'` and `quantity > 0` before executing.

### 8. No input validation on `/trade/approve/:id` and `/trade/reject/:id`
**File:** `backend/src/api/routes.ts:119-129`

These endpoints emit events without verifying the trade exists or is in PENDING status. A malicious actor could approve/reject any trade ID.

### 9. No rate limiting on API
**File:** `backend/src/api/index.ts`

The Express API has no rate limiting middleware, making it vulnerable to abuse (e.g., spamming `/trade/manual`).

**Fix:** Add `express-rate-limit`.

### 10. `runSQL` doesn't catch prepared statement errors
**File:** `backend/src/db/index.ts:67-80`

If `stmt.step()` throws (e.g., constraint violation), the error propagates uncaught. The `saveDB()` call after `stmt.step()` also runs even if the step failed.

**Fix:** Wrap in try/catch and call `saveDB()` only on success.

### 11. `queryAll` has inconsistent return format
**File:** `backend/src/db/index.ts:41-60`

With params → uses prepared statements → returns `{ column: value }` objects. Without params → uses `db.exec()` → manually maps arrays to objects. The two paths can produce different results (e.g., integer vs string types).

### 12. `fetchBalance()` may filter out valid coins
**File:** `backend/src/trader/service.ts:35-49`

The condition `if (info && ((bal.total as any)[coin] || ...))` filters out coins where all values are `0`. A coin with `0` balance could be a valid holding (e.g., after a full sell).

### 13. `positions` table has unused `entry_id` and `exit_id` columns
**File:** `backend/src/db/schema.ts:62-63`

These foreign key columns are defined in the schema but never set or queried anywhere in the codebase.

### 14. `trades` table has unused `signal_id` column
**File:** `backend/src/db/schema.ts:9`

The `signal_id` column is defined but never populated when inserting trades.

### 15. No WebSocket auto-reconnect in frontend
**File:** `frontend/src/hooks/useWebSocket.ts`

If the connection drops, there's no reconnection logic. The frontend loses all real-time updates until the page is refreshed.

**Fix:** Add a reconnect attempt on `onclose` with exponential backoff.

### 16. `checkOpenPositions` creates unauthenticated exchange per position
**File:** `backend/src/portfolio/index.ts:26-28`

Each position check creates a new unauthenticated `ccxt.binance()` instance. This is both wasteful and means rate limits apply per instance.

### 17. `TELEGRAM_CHAT_ID` read directly from `process.env`
**File:** `backend/src/telegram/bot.ts:50`

`sendApprovalMessage` reads `TELEGRAM_CHAT_ID` directly from `process.env` instead of going through the config module. This is inconsistent with the rest of the codebase and bypasses the config validation.

### 18. `DEFAULT_CHANGE` in stub computed once at module load
**File:** `backend/src/trader/stub.ts:30`

`const DEFAULT_CHANGE = Math.random() * 10 - 5` is evaluated once when the module loads. All subsequent calls return the same `change24h` value.

**Fix:** Move the random computation inside `fetchMarketData()`.

## 🟡 Low

### 19. Missing `@types/telegraf` in devDependencies
**File:** `backend/package.json`

The `telegraf` package is listed in dependencies but `@types/telegraf` is missing from devDependencies, which may cause TypeScript errors.

### 20. `formatTable` and `formatJSON` in scraper are unused
**File:** `backend/src/scraper/utils/output.js`

These formatting functions are never imported anywhere in the codebase. Remove them.

### 21. `setInterval` without cleanup in `start()`
**File:** `backend/src/index.ts:300`

The interval ID is never stored, so it can't be cleared on shutdown.

### 22. No error handling in `start()`
**File:** `backend/src/index.ts:290-303`

If `initDB()` fails, `startAPI()` and `startTelegramBot()` still run. If `tradingLoop()` fails, there's no recovery or alert.

### 23. `computePortfolioState` silently skips coins without market data
**File:** `backend/src/portfolio/index.ts:52-58`

If a coin in the balance has no matching market data, its value is silently skipped, undercounting the total portfolio value.

### 24. `bus.on()` handlers registered before DB is initialized
**File:** `backend/src/index.ts:230-288`

Event handlers for `trade_approved`, `trade_rejected`, `stop_loss_hit`, and `take_profit_hit` are registered at module load time, before `initDB()` runs. If an event somehow fires before the DB is ready, `runSQL` will throw.

**Fix:** Move these handlers inside `start()` after `initDB()`.
