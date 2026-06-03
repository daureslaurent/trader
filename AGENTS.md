# CryptoBot — AI Editing Guide

## Project Structure
- `backend/src/` — Node.js TypeScript backend
  - `index.ts` — entry point, wires all modules
  - `config/` — env vars, constants
  - `core/` — logger, event bus, error classes
  - `db/` — SQLite via sql.js, schema, queries
  - `trader/` — Binance integration via ccxt
  - `analyst/` — LLM analysis (OpenAI-compatible)
  - `researcher/` — web search via headless browser (DuckDuckGo)
  - `scraper/` — Puppeteer-based search engine
  - `telegram/` — Telegram bot via telegraf
  - `api/` — Express REST + WebSocket
- `frontend/src/` — React + Vite + Tailwind
  - `pages/` — Dashboard, Portfolio, Settings
  - `components/` — TradeApproval, TradeHistory
  - `hooks/` — useWebSocket

## Conventions
- Every module has an `index.ts` that exports its public API
- Modules never import each other's internals — only via `index.ts`
- All side effects go through the event bus (`core/events.ts`)
- Types are defined in `types.ts` per module, shared types in `src/types.ts`
- SQLite via sql.js, persist with `saveDB()`

## Key Patterns
- `bus.emit('event_name', data)` — emit an event
- `bus.on('event_name', handler)` — subscribe to events
- `logger.info/warn/error('msg', { data })` — structured JSON logging
- `config.key` — access environment config
- `queryAll(sql, params?)` — return array of rows
- `queryOne(sql, params?)` — return single row or null
- `runSQL(sql, params?)` — execute INSERT/UPDATE, returns { changes, lastInsertRowid }

## API Endpoints (backend port 3000)
- GET /api/portfolio, /api/decisions, /api/trades, /api/settings
- POST /api/trade/approve/:id, /api/trade/reject/:id, /api/trade/manual
- PUT /api/settings
- WS /ws — real-time events

## Trading Loop
1. Fetch top 20 USDT pairs + watchlist
2. Research each coin (web search via headless browser)
3. Analyze via LLM → BUY/SELL/HOLD signal
4. Execute or request approval
5. Snapshot portfolio
6. Repeat every N minutes
