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
docker-compose up   # backend on :3000, frontend on :5173 (data/ is bind-mounted)
```

There are no unit tests; `npm run lint` (type-check) is the only automated gate. Verify behavior by running the app.

**CLI flag** on the backend process: `--approval` forces human approval for every trade signal (same effect as the `approval_required` setting).

## Architecture

Monorepo with two independent Node packages: `backend/` (Node.js + TypeScript ESM) and `frontend/` (React + Vite + Tailwind). No shared package — they talk over HTTP + a WebSocket at `ws://localhost:3000/ws`. The backend is a single long-running process orchestrated by `backend/src/index.ts` (~1400 lines — the trade-execution brain).

### The four cron-driven engines

`index.ts` schedules four independent loops, each with its own cron expression stored in settings:

1. **Pipeline** (`pipeline_cron`) — the entry engine. For each watched/held coin runs: **Researcher** (Puppeteer/DuckDuckGo web search) → **Extractor** (LLM compresses articles to structured sentiment) → article **selection** (LLM) → **Analyst** (LLM produces BUY/SELL/HOLD + confidence + SL/TP %). A BUY passes a gauntlet of gates (max positions, already-held, pending-intent, min-USDC, position size, **fee-edge** gate) before executing or being handed to the entry-timing engine. Coins already held are **skipped** — they belong to the monitor.
2. **Discoverer** (`discover_cron`, `discoverer/`) — LLM-scored search for new candidate coins; approved discoveries feed the watchlist.
3. **Monitor** (`monitor_cron`, `monitor/`) — reviews **open positions** and proposes SL/TP adjustments, CLOSE, or REDUCE. This is the only engine that manages held coins.
4. **Position check** — a 30s `setInterval` (not cron) reconciling open positions against live prices and exchange OCO fills.

When the frontend saves settings, `settings_updated` reschedules the affected crons live.

### Trade execution is event-bus driven

`core/events.ts` exports a typed `bus` (EventEmitter). The engines never execute trades directly — they emit events that `index.ts` handlers act on. Key flows:
- `entry_fire` → deferred BUY fires at a good price (re-checks all gates first).
- `trade_approved` / `trade_rejected` → resolves a pending human approval.
- `position_adjustment_proposed` / `adjustment_approved` → applies monitor SL/TP changes.
- `monitor_close_requested` / `monitor_reduce_requested` → monitor exits.

**`submitTrade()` is the single choke point** for all real exchange orders. It guards concurrent exits with an in-memory `exitsInFlight` set (only one path may market-sell a given position at once), cancels the exchange OCO before selling, and does all DB writes (trade record + position + portfolio entries) inside one `withTransaction()`. SL/TP percentages from the analyst are applied at the **real fill price**, falling back to ATR sizing only when absent.

### Entry-timing engine (`entry/`)

When `entry_timing_enabled`, a BUY signal is not filled at the cron tick. It's registered as an **intent** that watches the live price feed and fires only on a pullback / in-band fill, or is cancelled by invalidate-drop / chase-cap / TTL. The entry band is based on the **live** price at registration (not the analyzed price, which is minutes-stale by the time the slow LLM pipeline finishes for that coin). Position size and the fee-edge gate stay on the analyzed (decision-time) price.

### LLM integration (`core/llm.ts` + per-module config)

All LLM calls use the OpenAI SDK pointed at local OpenAI-compatible endpoints (Ollama / llama.cpp). Each module has its **own** base URL + model + max-tokens, configured in `config/index.ts` from env vars that all fall back to `LLAMA_BASE_URL` / `LLAMA_MODEL`: `EXTRACTOR_*`, `ANALYST_*`, `DISCOVERER_*`, `DISCOVERER_EXTRACTOR_*`, `MONITOR_*` (with an A/B slot — `MONITOR_*` and `MONITOR_*_B` — selected at runtime via the `monitor_model` setting).

`core/llm.ts` **serializes calls per base URL** by default (`_urlChains`): a local server processes one request at a time, so calls to the same URL chain sequentially while calls to *different* URLs run in parallel. `llm_allow_parallel_same_url` disables this. Every call is recorded to `llm_calls` and live ones are broadcast to the frontend's LLM activity view.

### Database (`db/`)

SQLite via **sql.js** (in-memory; loaded from and persisted to `data/cryptobot.db`). Saved on graceful shutdown and via `scheduleSave()`. Schema is managed by **versioned migrations** (`db/migrations.ts`) that execute the namespaced `.sql` files in `db/sql/{settings,trading,pipeline,cache}/` — a broken migration crashes startup (fail-fast) rather than leaving a half-migrated DB. Access only via the helpers: `queryAll`, `queryOne`, `runSQL`, `withTransaction`. Key tables: `trades`, `decisions`, `positions`, `position_adjustments`, `position_reviews`, `portfolio_entries`, `portfolio_snapshots`, `pipeline_events`, `coin_discoveries`, `llm_calls`, `settings`.

Settings live in the `settings` key-value table via `getSettings()` / `updateSetting()`. Env vars seed the corresponding DB setting on every startup, so `.env` stays authoritative for things like crons.

### Portfolio & base currency

**The quote/base currency is USDC, not USDT** (despite some function names like `getUsdtEntry` / `syncUsdtEntry`). Binance pairs are `<COIN>USDC`. `portfolio_entries` is the local position ledger (separate from Binance's records); the USDC balance is tracked as a virtual entry with `buy_price = 1.0` and synced from Binance each cycle. `detectExternalWithdrawal()` reconciles manual balance changes.

### Other backend modules

- `market/` — live price cache (WebSocket-backed `getPrice`/`subscribe`) **and** OHLCV/candle fetching for indicators.
- `trader/` — ccxt Binance wrapper (`fetchMarketData`, `executeTrade`, `getTopPairs`). **No stub mode** — Binance keys are required.
- `portfolio/` — position sizing, ATR-based SL/TP, OCO placement (`placeProtection`/`replaceProtection`/`cancelProtection`), fee-aware realized PnL (`netRealizedPnl`), the `hasSufficientEdge` fee-edge gate.
- `scraper/` — Puppeteer-extra (stealth) browser + DuckDuckGo search engine used by the researcher.
- `telegram/` — Telegraf bot for trade approvals and a menu UI; `notifier.ts` pushes events. Disabled if `TELEGRAM_BOT_TOKEN` is unset.
- `api/` — Express routes (`routes.ts`) + WebSocket broadcast (`ws.ts`).

### Conventions

- **Every module exposes its public API via `index.ts`** — never import a module's internal files directly.
- Cross-module side effects go through the event bus (`bus.emit` / `bus.on`), with the event map typed in `core/events.ts`. Add new events to that map.
- Structured logging only: `logger.info/warn/error('msg', { data })`.
- Shared types in `backend/src/types.ts`; module-local types in `module/types.ts`.
- Frontend → backend live updates flow through `broadcast(event, payload)` in `api/ws.ts`, consumed by the `useWebSocket` hook.

### Frontend

Single-page app, **no router library** — page switching is `useState<Page>` in `App.tsx` with a `Sidebar` (`components/layout/`). Pages live in `pages/` (Dashboard, Portfolio, Trade, Monitor, EntryDesk, Discover, Charts, LLM/LLMStats/LLMDebug, CacheView, TradingState, Settings, Logs). Theming via `contexts/ThemeContext` (4 themes); data via typed hooks in `hooks/` (`useApi`, `useWebSocket`, `usePrices`, `useLLMActivity`); charts via recharts (`CandleChart`).

## Environment variables

Required: `BINANCE_API_KEY`, `BINANCE_SECRET`, `LLAMA_BASE_URL`, `LLAMA_MODEL`.
Optional per-module LLM overrides (default to the `LLAMA_*` values): `EXTRACTOR_*`, `ANALYST_*`, `DISCOVERER_*`, `DISCOVERER_EXTRACTOR_*`, `MONITOR_*` / `MONITOR_*_B` (each `_BASE_URL`, `_MODEL`, `_MAX_TOKENS`).
Optional other: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PORT` (3000), `APPROVAL_TIMEOUT_MINUTES` (5), `PIPELINE_CRON`.
