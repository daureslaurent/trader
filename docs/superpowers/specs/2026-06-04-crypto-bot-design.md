# Crypto Portfolio Management Bot — Design Spec

## Overview
A personal crypto portfolio bot that monitors top-20 coins + user watchlist, researches news via web search, analyzes opportunities via a local Llama LLM, and trades on Binance. Controlled via web frontend and Telegram. Dockerized for VPS/home server deployment.

## Architecture

**Pattern:** Monolithic Node.js backend + separate React frontend, connected via Docker Compose.

```
Docker Host
├── Backend Container (Node 22 + TypeScript)
│   ├── trader/     — Binance buy/sell via ccxt
│   ├── analyst/    — LLM analysis (local Llama, OpenAI-compatible API)
│   ├── researcher/ — Web search (SerpAPI/Google)
│   ├── telegram/   — Telegram bot (telegraf)
│   ├── api/        — Express REST + WebSocket for frontend
│   ├── db/         — SQLite via better-sqlite3
│   └── core/       — Event bus, logger, shared types
├── Frontend Container (React + Vite + Tailwind + Recharts)
└── SQLite volume (persistent)
```

## Project Structure

```
cryptobot/
├── AGENTS.md              ← AI instructions for editing
├── .env.example
├── docker-compose.yml
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              ← entry point, starts all modules
│       ├── config/index.ts       ← env vars, constants
│       ├── trader/
│       │   ├── index.ts          ← public API exports
│       │   ├── service.ts        ← buy/sell/balance via ccxt
│       │   └── types.ts
│       ├── analyst/
│       │   ├── index.ts
│       │   ├── service.ts        ← calls Llama via openai package
│       │   └── prompts.ts        ← LLM prompt templates
│       ├── researcher/
│       │   ├── index.ts
│       │   └── service.ts        ← fetches news + sentiment
│       ├── telegram/
│       │   ├── index.ts
│       │   ├── bot.ts            ← command handlers, approval buttons
│       │   └── types.ts
│       ├── api/
│       │   ├── index.ts
│       │   ├── routes.ts         ← REST endpoints
│       │   └── ws.ts             ← WebSocket event push
│       ├── db/
│       │   ├── index.ts
│       │   ├── schema.ts         ← table definitions
│       │   └── migrations.ts     ← auto-run on startup
│       ├── core/
│       │   ├── events.ts         ← EventEmitter-based pub/sub bus
│       │   ├── logger.ts
│       │   └── errors.ts
│       └── types.ts              ← shared domain types
└── frontend/
    ├── Dockerfile
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.ts
    └── src/
        ├── App.tsx
        ├── hooks/useWebSocket.ts
        ├── pages/
        │   ├── Dashboard.tsx      ← portfolio overview, live trades
        │   ├── Portfolio.tsx      ← holdings, P&L, history
        │   └── Settings.tsx       ← watchlist, interval, approval toggle
        └── components/
            ├── TradeApproval.tsx   ← popup for pending approvals
            └── TradeHistory.tsx
```

## Data Flow — Trading Loop

```
Interval (configurable, default 60min)
    │
    ▼
Researcher — fetches news + sentiment for each watched coin
    │
    ▼
Analyst — sends market data + research to Llama
    │   Returns: { action, coin, quantity, reason, confidence }
    │
    ▼
Trader — checks signal
    ├── HOLD → log decision, skip
    ├── BUY/SELL + no --approval → execute immediately
    └── BUY/SELL + --approval → push to frontend + Telegram
         │   Frontend: WebSocket → TradeApproval popup
         │   Telegram: inline buttons [Approve] [Reject]
         │
         ▼
    First response wins (or timeout → expired)
         │
         ├── Approve → execute, emit trade_executed
         └── Reject  → log as rejected
```

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js 22 + TypeScript | User request, AI-friendly types |
| HTTP/WS | Express + ws | Minimal, well-known |
| Binance | ccxt | Mature multi-exchange lib, handles rate limits |
| LLM Client | openai npm package | OpenAI-compatible, works with local Llama |
| Web Search | axios + SerpAPI | Simple, bring-your-own-key |
| Database | better-sqlite3 | Zero setup, synchronous, portable |
| Telegram | telegraf | Best Node.js Telegram framework |
| Frontend | React + Vite + Tailwind + Recharts | Lightweight modern stack |
| CLI args | commander | --approval flag, --interval override |

## Database Schema (SQLite)

### trades
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| coin | TEXT | e.g. BTC/USDT |
| side | TEXT | BUY or SELL |
| quantity | REAL | Amount in base currency |
| price_usd | REAL | Execution price |
| total_usd | REAL | Total value |
| signal_id | INTEGER FK | Link to the decision that triggered it |
| status | TEXT | PENDING, EXECUTED, FAILED |
| approved | BOOLEAN | null if no approval needed |
| created_at | TEXT | ISO 8601 |

### decisions
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| coin | TEXT | |
| action | TEXT | BUY, SELL, HOLD |
| reason | TEXT | LLM reasoning |
| confidence | REAL | 0-1 scale |
| context | TEXT | JSON blob of prices, news used |
| triggered_trade_id | INTEGER FK | nullable |
| created_at | TEXT | |

### portfolio_snapshots
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| total_value_usd | REAL | |
| holdings | TEXT | JSON: { "BTC": 0.5, "USDT": 1000 } |
| created_at | TEXT | |

### settings
| Column | Type | Description |
|--------|------|-------------|
| key | TEXT PK | e.g. watchlist, interval, min_confidence |
| value | TEXT | JSON value |

## Approval Flow

1. Bot generates a trade signal via LLM
2. If `--approval` flag is set, emits `approval_requested` event
3. Frontend receives via WebSocket → shows `TradeApproval` modal with Accept/Reject
4. Telegram receives via bot → inline keyboard with Approve/Reject buttons
5. First response (frontend or Telegram) wins
6. Configurable timeout (default: 5 min) → auto-reject
7. Result emitted as `trade_approved` or `trade_rejected`

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/portfolio | Current portfolio snapshot |
| GET | /api/decisions | Recent LLM decisions |
| GET | /api/trades | Trade history |
| POST | /api/trade/approve/:id | Approve pending trade |
| POST | /api/trade/reject/:id | Reject pending trade |
| POST | /api/trade/manual | Manual buy/sell |
| GET | /api/settings | Get settings |
| PUT | /api/settings | Update settings |
| WS | /ws | Real-time events |

## Deployment

```yaml
# docker-compose.yml
services:
  backend:
    build: ./backend
    ports: ["3000:3000"]
    env_file: .env
    volumes: ["./data:/app/data"]

  frontend:
    build: ./frontend
    ports: ["5173:5173"]
    environment:
      - VITE_API_URL=http://backend:3000
```

Environment variables: `BINANCE_API_KEY`, `BINANCE_SECRET`, `LLAMA_BASE_URL`, `LLAMA_MODEL`, `SERPAPI_KEY`, `TELEGRAM_BOT_TOKEN`, `APPROVAL_TIMEOUT_MINUTES`.

## Configuration (settings DB)

Editable via frontend settings page:
- `watchlist` — array of coins beyond top-20
- `interval_minutes` — loop cadence
- `min_confidence` — threshold to ignore low-confidence signals
- `max_position_size_usd` — per-trade cap
- `approval_required` — override the --approval flag at runtime
