# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Backend** (run from `backend/`):
```bash
npm run dev      # tsx watch — hot-reload dev server on port 3000
npm start        # tsx — production start
npm run lint     # tsc --noEmit — type-check only (there is NO test runner)
npm run build    # tsc — compile to dist/
```

**Frontend** (run from `frontend/`):
```bash
npm run dev      # Vite dev server on port 5173
npm run build    # tsc + vite build
npm run preview  # serve the production build
```

**Docker** (from repo root):
```bash
docker-compose up   # mongo (single-node replica set rs0), backend on :3000, frontend on :5173
```

**Data migration** (one-off, legacy sql.js `data/*.db` → MongoDB), from `backend/`:
```bash
npm run migrate:mongo            # trading + settings collections (caches skipped)
npm run migrate:mongo -- --all   # include pipeline/cache too
npm run migrate:mongo -- --reset # wipe target collections first
```

There are no unit tests; `npm run lint` (type-check) is the only automated gate. Verify behavior by running the app.

**CLI flag** on the backend process: `--approval` forces human approval for every trade signal (same effect as the `approval_required` setting).

## Architecture

Monorepo with two independent Node packages: `backend/` (Node.js + TypeScript ESM) and `frontend/` (React + Vite + Tailwind). No shared package — they talk over HTTP + a WebSocket at `ws://localhost:3000/ws`. The backend is a single long-running process orchestrated by `backend/src/index.ts` (~1400 lines — the trade-execution brain).

### The cron-driven engines

`index.ts` schedules several independent loops, each with its own cron expression stored in settings:

1. **Pipeline** (`pipeline_cron`) — the entry engine. For each watched/held coin runs: **Researcher** (Puppeteer/DuckDuckGo web search) → **Extractor** (LLM compresses articles to structured sentiment) → article **selection** (LLM) → **Analyst** (LLM produces BUY/SELL/HOLD + confidence + SL/TP %). A BUY passes a gauntlet of gates (max positions, already-held, pending-intent, min-USDC, position size, **fee-edge** gate) before executing or being handed to the entry-timing engine. Coins already held are **skipped** — they belong to the monitor.
2. **Discoverer** (`discover_cron`, `discoverer/`) — LLM-scored search for new candidate coins; approved discoveries feed the watchlist.
3. **Monitor** (`monitor_cron`, `monitor/`) — the **Agent Monitor**: an agentic, tool-calling loop that reviews **open positions** (one review per position) and proposes SL/TP adjustments (ADJUST) or a full exit (CLOSE). The engine lives in `agent/monitor.ts` (alongside the other tool-calling agents); shared context-building + the post-decision safety net (`finalizeReview`) live in `monitor/context.ts`, a one-way `agent → monitor` dependency. It is registered as the `monitor` agent in the agent registry (read-only tool belt) and persists each run (verdict + transcript) to `monitor_runs` for the Agent Monitor page. This is the only engine that manages held coins.
4. **Summary** (`summary_cron`, `summary/`) — when `summary_auto_run`, an LLM portfolio strategist that bundles the whole portfolio + per-coin live Binance market context (price, 24h, RSI, trend, regime), recent trades, and recently closed positions into a narrative + structured briefing (health, risk level, observations, suggestions). Read-only: it never trades. Rows persist to `portfolio_summaries` (pruned by `summary_retain_days`), broadcast to the Summary page, and pushed to Telegram via `portfolio_summary_created`.
5. **Position check** — a 30s `setInterval` (not cron) reconciling open positions against live prices and exchange OCO fills.

When the frontend saves settings, `settings_updated` reschedules the affected crons live.

### Trade execution is event-bus driven

`core/events.ts` exports a typed `bus` (EventEmitter). The engines never execute trades directly — they emit events that `index.ts` handlers act on. Key flows:
- `entry_fire` → deferred BUY fires at a good price (re-checks all gates first).
- `trade_approved` / `trade_rejected` → resolves a pending human approval.
- `position_adjustment_proposed` / `adjustment_approved` → applies monitor SL/TP changes.
- `monitor_close_requested` → monitor-initiated full exit.

**`submitTrade()` is the single choke point** for all real exchange orders. It guards concurrent exits with an in-memory `exitsInFlight` set (only one path may market-sell a given position at once), cancels the exchange OCO before selling, and does all DB writes (trade record + position + portfolio entries) inside one `withTransaction()`. SL/TP percentages from the analyst are applied at the **real fill price**, falling back to ATR sizing only when absent.

### Entry-timing engine (`entry/`)

When `entry_timing_enabled`, a BUY signal is not filled at the cron tick. It's registered as an **intent** that watches the live price feed and fires only on a pullback / in-band fill, or is cancelled by invalidate-drop / chase-cap / TTL. The entry band is based on the **live** price at registration (not the analyzed price, which is minutes-stale by the time the slow LLM pipeline finishes for that coin). Position size and the fee-edge gate stay on the analyzed (decision-time) price.

The four band parameters (pullback target, invalidate, chase cap, TTL) are normally the static global `entry_*` settings. When `entry_planner_enabled` is also on, the **Entry Planner** LLM module (`entryPlanner/`) decides them **per coin** for each deferred BUY — given live market context + the analyst's BUY thesis — via `planEntry()`. `resolveEntryBand(plan, settings)` materializes the choice: a non-null plan wins (`source: 'llm'`), otherwise it falls back to the static settings (`source: 'static'`). Failure is graceful: a disabled feature, LLM error/timeout, or invalid/unparseable output all fall back to the static band. Values are **not** clamped (only basic sanity: positive numbers, invalidate below the pullback target). The resolved band's `source` + `reason` are persisted on the intent and surfaced on the Entry Desk (an "AI levels" badge + the planner's one-line rationale). The runner (`pipeline/runner.ts handleBuySignal`) calls the planner only **after** the BUY gauntlet passes and only when entry timing is on, so no LLM call is wasted on a rejected BUY. Selectable in Settings → LLM Models as the `entryPlanner` module (env fallback `ENTRY_PLANNER_*`).

### LLM integration (`core/llm.ts` + per-module config)

All LLM calls use the OpenAI SDK pointed at local OpenAI-compatible endpoints (Ollama / llama.cpp). Endpoints are managed as a **shared catalog** (`llm_endpoints` setting): each entry is a named `{ baseURL, model, maxTokens, parallel }` defined once in the Settings → LLM Models "Manage endpoints" modal. Each module then **selects** an endpoint from that catalog by id (`llm_<module>_endpoint`). Max-tokens follows a precedence chain (`resolveMaxTokens` in `config/llm.ts`): a positive per-module override (`llm_<module>_max_tokens`) > the endpoint's own `maxTokens` default > the env default. The env-var config in `config/index.ts` (from `EXTRACTOR_*`, `ANALYST_*`, `DISCOVERER_*`, `DISCOVERER_EXTRACTOR_*`, `MONITOR_*`, `SUMMARY_*`, `ENTRY_PLANNER_*`, `AGENT_*`, all falling back to `LLAMA_BASE_URL` / `LLAMA_MODEL`) is the **fallback when no endpoint is selected** — a blank selection (or a deleted/incomplete endpoint) resolves to the module's env default. The monitor is the agentic Agent Monitor (`monitor` module, `MONITOR_*`); it should point at a tool-calling-capable model.

Each module can also select an optional **fallback** endpoint from the same catalog (`llm_<module>_fb_endpoint` + `_fb_max_tokens`). `resolveLLM()` in `config/llm.ts` looks the selected ids up in the catalog and returns an `LLMTarget` fallback alongside the primary; modules pass it straight to `llmChat(...)` as the 4th arg. `llmChat` tries the primary and, only if that call **throws** (endpoint down, timeout, 5xx, unknown model), retries the same prompt once against the fallback — a fallback identical to the primary is treated as "no fallback". Each attempt is logged as its own `llm_calls` row under its real base_url/model, so a failover shows as a failed primary row followed by a fallback row. The catalog/selections are Settings-only (no env seeding) and empty-but-non-throwing responses do **not** trigger failover (that stays the module's own parse/retry concern).

`core/llm.ts` gates calls with **per-key counting semaphores** (`_gates` + `runLimited`/`resolveGate`). By default each base URL is capped at one in-flight call (gate limit 1), so a local one-at-a-time server is serialized while calls to *different* URLs run in parallel. A catalog endpoint flagged **`parallel`** lifts that cap; if it also sets **`maxParallel` > 0**, its calls run under a gate keyed by endpoint (base URL + model) at that limit (excess calls queue), otherwise parallelism is unlimited. The global `llm_allow_parallel_same_url` lifts the limit-1 default for every URL (per-endpoint `maxParallel` caps still apply). A freed permit is handed straight to the next FIFO waiter, so capacity holds without races. Every call is recorded to `llm_calls` and live ones are broadcast to the frontend's LLM activity view.

### Database (`db/`)

**MongoDB** via the native `mongodb` driver. One database (`cryptobot`, set by `MONGO_DB`) with one collection per former table. Connection is `MONGO_URL` (default `mongodb://localhost:27017/?directConnection=true`); `initDB()` connects and ensures indexes (`db/indexes.ts`). Access collections through the thin typed **`Repository`** instances in `db/repositories.ts` (`trades`, `positions`, `portfolioEntries`, `decisions`, …) — never reach into the driver directly. Repos expose async `find/findOne/findById/insert/update/upsert/deleteOne/deleteMany/count/aggregate`.

- **Integer ids preserved**: former `INTEGER PRIMARY KEY AUTOINCREMENT` rows keep integer ids via a `counters` collection (`nextId()`), stored as **both `_id` and `id`** so existing `row.id` reads/filters work. Natural-key collections (settings→key, monitor_notes→coin, entry_intents/entry_events→id, extraction_cache→url, ohlcv_cache→cache_key) use `Repository(..., false)` and set `_id` to the natural key.
- **`created_at`** stays the `'YYYY-MM-DD HH:MM:SS'` UTC string (`nowSql()` in `db/time.ts`).
- **Transactions**: `withTransaction(async session => …)` over a Mongo session (single-node replica set `rs0`, started by docker-compose). Pass the `session` into each repo write so it enrolls. `submitTrade()`/`closePositionFromExit()` use this for atomic trade+position+portfolio writes.

Settings live in the `settings` collection (`_id` = key). `getSettings()` is **synchronous**, served from an in-memory cache loaded once at startup by `loadSettings()` and kept current by the async `updateSetting()`. Env vars seed the corresponding setting on startup, so `.env` stays authoritative for things like crons.

Legacy sql.js data lives in `data/*.db` and is one-off migrated by `scripts/migrate-sqlite-to-mongo.ts` (`npm run migrate:mongo`).

### Portfolio & base currency

**The quote/base currency is USDC, not USDT** (despite some function names like `getUsdtEntry` / `syncUsdtEntry`). Binance pairs are `<COIN>USDC`. `portfolio_entries` is the local position ledger (separate from Binance's records); the USDC balance is tracked as a virtual entry with `buy_price = 1.0` and synced from Binance each cycle. `detectExternalWithdrawal()` reconciles manual balance changes.

### Other backend modules

- `market/` — live price cache (WebSocket-backed `getPrice`/`subscribe`) **and** OHLCV/candle fetching for indicators.
- `trader/` — ccxt Binance wrapper (`fetchMarketData`, `executeTrade`, `getTopPairs`). **No stub mode** — Binance keys are required.
- `portfolio/` — position sizing, ATR-based SL/TP, OCO placement (`placeProtection`/`replaceProtection`/`cancelProtection`), fee-aware realized PnL (`netRealizedPnl`), the `hasSufficientEdge` fee-edge gate.
- `scraper/` — Puppeteer-extra (stealth) browser + DuckDuckGo search engine used by the researcher.
- `telegram/` — Telegraf bot for trade approvals and a menu UI; `notifier.ts` pushes events. Disabled if `TELEGRAM_BOT_TOKEN` is unset.
- `agent/` — request-driven (not cron) conversational assistant behind the **Agent** page. A native **tool-calling loop** (`service.ts`) runs the `AGENT_*` model via `llmChat`; the model calls tools from `tools.ts` to read app data (portfolio, positions, trades, watchlist, live market/indicators, signals, discoveries, summary, reviews, settings) and to take **safe, non-trading actions** (add/remove watchlist coins; trigger the pipeline/discovery/summary/monitor engines via existing bus events). There are **no** trade/settings-mutation tools. Conversations + full transcripts (incl. assistant `tool_calls` and tool results) persist to `agent_conversations`/`agent_messages`; live turn progress streams to the frontend as `agent_step` WS events.
- `api/` — Express routes (`routes.ts`) + WebSocket broadcast (`ws.ts`).

### Conventions

- **Every module exposes its public API via `index.ts`** — never import a module's internal files directly.
- Cross-module side effects go through the event bus (`bus.emit` / `bus.on`), with the event map typed in `core/events.ts`. Add new events to that map.
- Structured logging only: `logger.info/warn/error('msg', { data })`.
- Shared types in `backend/src/types.ts`; module-local types in `module/types.ts`.
- Frontend → backend live updates flow through `broadcast(event, payload)` in `api/ws.ts`, consumed by the `useWebSocket` hook.

### Frontend

Single-page app, **no router library** — page switching is `useState<Page>` in `App.tsx` with a `Sidebar` (`components/layout/`). Pages live in `pages/` (Dashboard, Agent, Portfolio, Trade, Monitor, EntryDesk, Discover, Charts, LLM/LLMStats/LLMDebug, CacheView, TradingState, Settings, Logs). Theming via `contexts/ThemeContext` (4 themes); data via typed hooks in `hooks/` (`useApi`, `useWebSocket`, `usePrices`, `useLLMActivity`); charts via recharts (`CandleChart`).

## Environment variables

Required: `BINANCE_API_KEY`, `BINANCE_SECRET`, `LLAMA_BASE_URL`, `LLAMA_MODEL`.
Optional per-module LLM overrides (default to the `LLAMA_*` values): `EXTRACTOR_*`, `ANALYST_*`, `DISCOVERER_*`, `DISCOVERER_EXTRACTOR_*`, `MONITOR_*`, `SUMMARY_*`, `ENTRY_PLANNER_*`, `AGENT_*` (each `_BASE_URL`, `_MODEL`, `_MAX_TOKENS`).
Optional other: `MONGO_URL` (default `mongodb://localhost:27017/?directConnection=true`), `MONGO_DB` (default `cryptobot`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PORT` (3000), `APPROVAL_TIMEOUT_MINUTES` (5), `PIPELINE_CRON`.

Offline mode (deterministic, LLM-free trading): `OFFLINE_MODE` (`true`/`false` — manual force), `OFFLINE_AUTO` (default `true` — auto-fall-back to rules when every LLM endpoint is down, recover when one returns), `OFFLINE_REUSE_MAX_AGE_MIN` (default `30` — freshness window for the offline analyst to reuse recent LLM-derived sentiment). Each only seeds its `settings` row when explicitly set; the effective mode is resolved in `core/offlineMode.ts` (`isOffline()`), driven by the endpoint health monitor, and shown by the top-bar mode badge.
