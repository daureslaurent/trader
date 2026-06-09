# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Backend** (run from `backend/`):
```bash
npm run dev      # tsx watch — hot-reload dev server on port 3000
npm start        # tsx — production start
npm run lint     # tsc --noEmit — type-check only (no test runner)
npm run build    # tsc — compile to dist/
```

**Frontend** (run from `frontend/`):
```bash
npm run dev      # Vite dev server on port 5173
npm run build    # tsc + vite build
```

**Docker** (from repo root):
```bash
docker-compose up   # backend on :3000, frontend on :5173
```

**CLI flags** passed to the backend process:
- `--approval` — require human approval for every trade signal

## Architecture

### Overview
Monorepo: `backend/` (Node.js + TypeScript ESM) and `frontend/` (React + Vite + Tailwind). No shared packages — they communicate via HTTP/WebSocket.

### Backend data flow
Each trading cycle (interval configurable in settings):
1. **Researcher** (`researcher/`) — headless Puppeteer/DuckDuckGo web search for each coin
2. **Extractor** (`extractor/`) — second LLM call to compress raw articles into structured sentiment
3. **Analyst** (`analyst/`) — main LLM call using `portfolio/prompts.ts` to produce BUY/SELL/HOLD signal
4. **Trade execution** (`trader/`) — via ccxt Binance, or stub in dev mode
5. **Portfolio snapshot** — records total value + holdings to `portfolio_snapshots`

Pipeline progress is streamed to the frontend via WebSocket events (`broadcast()` in `api/ws.ts`) and persisted in the `pipeline_events` table.

### LLM integration
Both the extractor and analyst use the OpenAI SDK pointed at a local OpenAI-compatible endpoint (e.g. Ollama). Configured via `LLAMA_BASE_URL` / `LLAMA_MODEL`. The extractor and analyst can be split across different endpoints with `EXTRACTOR_BASE_URL` / `ANALYST_BASE_URL` overrides.

### Database
SQLite via sql.js (in-memory, loaded from and saved to `data/cryptobot.db`). Schema is in `db/schema.ts`. The DB is saved on graceful shutdown via `saveDB()`. Key tables: `trades`, `decisions`, `positions`, `portfolio_entries`, `portfolio_snapshots`, `pipeline_events`, `settings`.

Settings (watchlist, interval, risk params) are stored in the `settings` key-value table and accessed via `getSettings()` / `updateSetting()`.

### Portfolio tracking
`portfolio_entries` is the local position ledger — separate from Binance's own records. USDT balance is synced from Binance on each cycle via `syncUsdtEntry()` and tracked as a virtual entry with `buy_price = 1.0`.

Positions with stop-loss/take-profit are tracked in `positions`. The portfolio module (`portfolio/service.ts`) checks open positions against current prices and emits `stop_loss_hit` / `take_profit_hit` bus events, which are handled in `index.ts`.

### Conventions (from AGENTS.md)
- Every module exports its public API via `index.ts` — never import internals directly
- Side effects go through the event bus (`core/events.ts`): `bus.emit('event_name', data)` / `bus.on('event_name', handler)`
- Structured logging: `logger.info/warn/error('msg', { data })`
- DB helpers: `queryAll(sql, params?)`, `queryOne(sql, params?)`, `runSQL(sql, params?)`
- Shared types in `src/types.ts`; module-local types in `module/types.ts`

### Frontend
Single-page app with tab-based navigation managed by `useState` in `App.tsx` (no router library). Real-time updates via `useWebSocket` hook connecting to `ws://localhost:3000/ws`. Trade approval UI is in `components/TradeApproval.tsx` and `components/TradeHistory.tsx`.

## Environment variables
Required: `LLAMA_BASE_URL`, `LLAMA_MODEL`  
Optional (bypassed in `--stub` mode): `BINANCE_API_KEY`, `BINANCE_SECRET`  
Optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `EXTRACTOR_BASE_URL`, `EXTRACTOR_MODEL`, `ANALYST_BASE_URL`, `ANALYST_MODEL`, `PORT`, `APPROVAL_TIMEOUT_MINUTES`
