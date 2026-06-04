# CryptoBot — Code Review Issues

> Generated: 2026-06-04

---

## 🔴 Critical (7) — Fix First

### 1. `broadcast()` never called — real-time frontend is dead
**File:** `backend/src/api/ws.ts:22`

The `broadcast()` function exists but is never imported or used anywhere in the codebase. Events like `portfolio_updated`, `trade_executed`, and `approval_requested` fire on the event bus but never reach frontend WebSocket clients. The frontend dashboard only shows data fetched on initial load — no live updates work.

### 2. `setInterval` without `await` — overlapping loops corrupt state
**File:** `backend/src/index.ts:173`

```ts
setInterval(tradingLoop, intervalMs)
```

`tradingLoop` is async but `setInterval` doesn't await the returned promise. If the loop takes longer than the configured interval, multiple instances run concurrently, simultaneously mutating `pendingApprovals`, `approvalTimers`, and the database.

### 3. `saveDB()` on every SQL write — massive I/O + race condition
**File:** `backend/src/db/index.ts:67-80`

Every `runSQL()` call writes the entire SQLite database to disk via `saveDB()`. For 20 coins per minute, this creates unnecessary I/O and SSD wear. Worse: concurrent `runSQL()` calls can interleave with `saveDB()`'s `export()`+`writeFileSync`, corrupting the file.

### 4. `start` script uses uninstalled `ts-node`
**File:** `backend/package.json:8`

```json
"start": "node --loader ts-node/esm src/index.ts"
```

Only `tsx` is in dependencies. This script fails with `ERR_MODULE_NOT_FOUND`. Should use `tsx` instead.

### 5. No Express error-handling middleware
**File:** `backend/src/api/index.ts`

No `(err, req, res, next)` error-handling middleware is registered. If any route handler throws synchronously (e.g., malformed `JSON.parse` in `/portfolio`), Express returns a bare HTML 500 or crashes the process.

### 6. Watchlist corrupted on every keystroke
**File:** `frontend/src/pages/Settings.tsx:42`

```ts
onChange={(e) => setSettings({
  ...settings,
  watchlist: e.target.value.split(',').map((s) => s.trim() + '/USDT')
})}
```

The input already shows pairs as `BTC/USDT, ETH/USDT`. The handler unconditionally appends `/USDT`. Saving without changes produces `BTC/USDT/USDT, ETH/USDT/USDT`. Each edit compounds the corruption.

### 7. Stale closure in `useWebSocket`
**File:** `frontend/src/hooks/useWebSocket.ts:29`

```ts
useEffect(() => { /* uses onMessage */ }, [])  // empty deps
```

The `useEffect` captures `onMessage` from the closure with an empty dependency array. If the parent component re-renders and passes a new `onMessage` callback, the WebSocket handler continues invoking the stale original one.

---

## 🟠 Medium (20+) — Significant Impact

### Backend

| # | File | Issue |
|---|------|-------|
| M1 | `backend/src/index.ts:57` | `(err as Error).message` produces `"undefined"` string when caught value isn't an `Error` (e.g., a thrown string). Use `err instanceof Error ? err.message : String(err)`. |
| M2 | `backend/src/index.ts:33` | Portfolio percent calculation divides by `0.01` guard. If all prices are zero, this yields wildly inflated percentages. |
| M3 | `backend/src/config/index.ts` | `num()` helper returns `NaN` silently when env var is non-numeric. `NaN` propagates to `approvalTimeoutMs` and `port`. |
| M4 | `backend/src/config/index.ts` | `LLAMA_BASE_URL` and `LLAMA_MODEL` required even in `--stub` mode. True offline dev requires setting dummy LLM vars. |
| M5 | `backend/src/core/logger.ts` | `LOG_LEVEL` env var unvalidated. `LOG_LEVEL=banana` compiles but silently suppresses all logs. |
| M6 | `backend/src/core/logger.ts` | `warn()` writes to stdout instead of stderr. |
| M7 | `backend/src/core/errors.ts` | No `Error.cause` propagation — original errors are lost when wrapped. |
| M8 | `backend/src/db/index.ts:43-49` | `queryAll()` with params never calls `stmt.free()` if `stmt.bind()` or `stmt.step()` throws — prepared statement memory leak. |
| M9 | `backend/src/db/index.ts:87` | `getSettings()` does `JSON.parse(map.watchlist)` without try/catch. Corrupted DB data crashes the entire trading loop. |
| M10 | `backend/src/db/schema.ts` | No indexes on `created_at` — all `ORDER BY created_at DESC LIMIT 50` queries perform full table scans. |
| M11 | `backend/src/trader/service.ts:59` | `createMarketBuyOrder` in ccxt interprets `amount` as quote currency (USDT), not base coin. BUY orders execute wrong size. SELL is fine. |
| M12 | `backend/src/trader/service.ts:40` | `as any` casts on `bal.total`, `bal.free`, `bal.used` — complete loss of type safety. |
| M13 | `backend/src/trader/service.ts:72` | `fetchTickers()` without args fetches all 2000+ Binance pairs. Slow, rate-limited, and wasteful. Should use exchange info endpoint. |
| M14 | `backend/src/analyst/service.ts:33` | `max_tokens: 28000` exceeds most local LLM context windows (4096-8192). Responses will be silently truncated. |
| M15 | `backend/src/analyst/service.ts:23` | Full prompt logged at `info` level — leaks portfolio data and article content. Should be `debug`. |
| M16 | `backend/src/analyst/service.ts:49` | Only `action` validated (BUY/SELL/HOLD). LLM can return `quantity: -5` or `confidence: 999` which flows unchecked into trades. |
| M17 | `backend/src/analyst/prompts.ts` | Hardcoded "max 100 USDT" in prompt ignores `settings.max_position_size_usd`. LLM recommends inconsistent amounts. |
| M18 | `backend/src/researcher/service.ts:22` | Dynamic `await import('../scraper/search.js')` on every call instead of static top-level import. Adds unnecessary async overhead. |
| M19 | `backend/src/researcher/service.ts:23` | Year `"2026"` hardcoded in search query — stale results after 2026. |
| M20 | `backend/src/telegram/bot.ts:50` | `.catch(() => {})` swallows all Telegram send errors. If bot token is revoked or chat ID wrong, nobody knows. |
| M21 | `backend/src/telegram/bot.ts:22` | `as any` cast on `queryOne` result — bypasses type safety. |
| M22 | `backend/src/telegram/bot.ts:50` | `TELEGRAM_CHAT_ID` read directly from `process.env` instead of the config module. Not documented in `.env.example`. Risk: read before dotenv loads. |
| M23 | `backend/src/telegram/bot.ts` | No authentication on `/approve`/`/reject` — any Telegram user who finds the bot can approve/reject trades. |
| M24 | `backend/src/api/routes.ts` | No input validation (no zod/joi) on any endpoint. `/trade/manual` accepts arbitrary `side`. `/settings` accepts any key-value pair. |
| M25 | `backend/src/api/routes.ts:42-46` | Manual trade executes on Binance (`executeTrade`) **before** the DB INSERT. If the DB write fails, the executed trade is never recorded. |
| M26 | `backend/src/scraper/browser.js` | `closeBrowser()` is defined but never called on app exit. Chrome processes leak every run. |
| M27 | `backend/src/scraper/browser.js` | No health check or crash detection. If the browser process dies, the stale reference causes cryptic errors on next use. |
| M28 | `backend/src/scraper/engines/duckduckgo.js` | Fragile DuckDuckGo-specific CSS selectors (`article[data-testid="result"]`, etc.). These are internal attributes that change without notice — the single most likely scraper failure point. |
| M29 | `backend/src/scraper/utils/fetchPageText.js` | Strips `<nav>`, `<footer>`, `<header>` elements, but many news sites put article content in these. Loses valuable text. |
| M30 | `backend/src/scraper/utils/output.js` | Entire module (`formatTable`, `formatJSON`) is dead code — never imported or used. |

### Frontend

| # | File | Issue |
|---|------|-------|
| F1 | `frontend/src/pages/Dashboard.tsx:23-24` | `.catch(() => {})` on all fetches — errors silenced. User sees `$0.00` portfolio and `0` trades during API failures. |
| F2 | `frontend/src/pages/Portfolio.tsx:12` | `.catch(() => {})` on portfolio fetch. If API fails, perpetual "Loading..." with no error feedback. |
| F3 | `frontend/src/pages/Logs.tsx:65` | Array index as React key `key={i}` — causes DOM reuse bugs when entries are prepended/reordered. |
| F4 | `frontend/src/pages/Settings.tsx:22-27` | Save has no try/catch. If PUT fails, `setSaving(false)` still runs, UI looks like save succeeded. |
| F5 | `frontend/src/pages/Settings.tsx:47` | `parseInt('')` → `NaN` when number input is cleared. `NaN` is sent to backend. |
| F6 | `frontend/src/pages/Settings.tsx:55` | `max_position_size_usd` uses `parseInt` instead of `parseFloat` — truncates decimal values. |
| F7 | `frontend/src/hooks/useWebSocket.ts` | No auto-reconnect with exponential backoff. A network blip disconnects permanently until manual refresh. |
| F8 | `frontend/src/hooks/useWebSocket.ts:21-25` | Single `try/catch` around both `JSON.parse` and `onMessage?.(msg)`. If the handler throws, error is swallowed as "malformed." |
| F9 | `frontend/package.json` | `recharts` listed in dependencies but never imported — adds ~500KB to production bundle. |
| F10 | `frontend/src/components/TradeApproval.tsx` | No loading/disabled state on Approve/Reject buttons. Double-click sends duplicate requests. |
| F11 | `frontend/src/pages/Logs.tsx` | `Trade` interface duplicated identically in `TradeHistory.tsx`. Should be shared. |
| F12 | `frontend/src/pages/Logs.tsx` | Portfolio snapshot events log `total_value_usd: 0` instead of the actual value from `msg.data`. |
| F13 | `frontend/src/pages/Logs.tsx` | `entry.data.price &&` fails for valid price of `$0.00`. Should check `!== undefined && !== null`. |

### Infrastructure

| # | File | Issue |
|---|------|-------|
| I1 | `docker-compose.yml:12` | CMD override adds `--stub --approval` flags. Running the Docker image standalone gives different (potentially dangerous) behavior. |
| I2 | `backend/Dockerfile` | Runtime TypeScript compilation via `tsx` instead of pre-building with `tsc`. Slower startup, more memory. |
| I3 | `frontend/nginx.conf` | No security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, `Content-Security-Policy`). |
| I4 | `frontend/vite.config.ts` | Proxy target `http://backend:3000` only resolves in Docker. Running `npm run dev` locally fails. |
| I5 | `docker-compose.yml` | No healthchecks on any service. `depends_on` only checks container start, not service readiness. |
| I6 | `backend/Dockerfile` | Chromium + deps add ~500MB. No `HEALTHCHECK` defined. |

---

## 🟡 Low (20+)

| # | File | Issue |
|---|------|-------|
| L1 | `backend/src/db/schema.ts` | `signal_id` column in `trades` and `triggered_trade_id` in `decisions` are never populated — dead columns. |
| L2 | `backend/src/config/index.ts` | Fragile manual `process.argv` parsing. An env-var or proper CLI parser would be more robust. |
| L3 | `backend/src/core/errors.ts` | `code` property should be `readonly`. |
| L4 | `backend/src/core/events.ts` | `error` event defined in EventMap type but never emitted. Dead type entry. |
| L5 | `backend/src/core/events.ts` | Typed `emit`/`on` cast to `string`/`unknown[]` — wrong event name compiles fine. |
| L6 | `backend/src/core/events.ts` | No typed `off`/`removeListener` wrapper. |
| L7 | `backend/src/core/logger.ts` | `data` can overwrite `t`, `level`, `msg` fields via spread. |
| L8 | `backend/src/db/index.ts` | Directory path extraction bug: if `DB_PATH` has no `/`, `substring(0, -1)` → `''`, `mkdirSync('')` misbehaves. |
| L9 | `backend/src/db/index.ts` | `db.exec(sql)` allows multi-statement execution — SQL injection risk if user input is ever interpolated. |
| L10 | `backend/src/trader/service.ts` | `fetchMarketData` silently returns 0 for missing/delisted tickers. |
| L11 | `backend/src/trader/stub.ts` | `DEFAULT_CHANGE = Math.random() * 10 - 5` computed once at module load. All stub coins share the same change. |
| L12 | `backend/src/scraper/` | Entire scraper directory uses plain `.js` — no TypeScript, no type safety. Inconsistent with the rest of the backend. |
| L13 | `backend/src/scraper/search.js` | Redundant `.slice(0, count)` after `duckduckgoSearch` already limits results. |
| L14 | -- | No `process.on('SIGTERM')`/`SIGINT'` handlers anywhere. Browser, Telegram bot, HTTP server, and DB all terminate abruptly on exit. |
| L15 | -- | No `/health` or `/readyz` endpoint for container orchestration / monitoring. |
| L16 | -- | No database migration system. Adding a column requires manual SQL intervention. |
| L17 | -- | No retry logic on any external API call (Binance, LLM, DuckDuckGo, page fetches). Transient failures = hard errors. |
| L18 | -- | No `process.on('unhandledRejection')` handler. Un-awaited promise rejections crash Node in future versions. |
| L19 | `frontend/package.json` | No `engines` field. |
| L20 | `frontend/tsconfig.json` | `noUnusedLocals` and `noUnusedParameters` set to `false` — unused imports/vars pass silently. |
| L21 | `frontend/src/main.tsx` | `import React` unused with automatic JSX runtime. |
| L22 | `frontend/src/Dashboard.tsx` | `useState([])` infers `never[]` — loses type safety. |
| L23 | `frontend/src/App.tsx` | `tabs` array recreated on every render. |
| L24 | `frontend/src/App.tsx` | No `aria-*` attributes on tab buttons — accessibility issue. |
| L25 | `frontend/src/Portfolio.tsx` | No polling or real-time updates — data is fetched once on mount. |
| L26 | `frontend/index.html` | No favicon, no meta description. |
| L27 | `frontend/src/components/TradeHistory.tsx` | No pagination or virtual scrolling — DOM grows unbounded with trade history. |

---

## Summary

| Severity | Count |
|----------|-------|
| **Critical** | 7 |
| **Medium** | 30+ |
| **Low** | 27+ |

### Top 10 Most Impactful Issues

| Priority | Issue | Impact |
|----------|-------|--------|
| 1 | WebSocket `broadcast()` never called | Entire real-time feature non-functional |
| 2 | `setInterval` without await guard | State corruption from concurrent trading loops |
| 3 | `saveDB()` on every SQL write | I/O bottleneck + file corruption risk |
| 4 | `ts-node` in start script not installed | App won't start |
| 5 | No Express error middleware | Unhandled exceptions crash or hang the server |
| 6 | Watchlist double-`/USDT` corruption | Settings data integrity bug |
| 7 | Stale closure in `useWebSocket` | React stale callback bug |
| 8 | `createMarketBuyOrder` quantity semantics | Wrong trade sizes for BUY orders |
| 9 | No graceful shutdown (SIGTERM/SIGINT) | Zombie Chrome processes, data loss |
| 10 | No input validation on API routes | Accepts arbitrary/garbage data |
