<div align="center">

# 🤖 cryptoBot

### An autonomous, LLM-driven crypto trading system

*Research → reason → trade → monitor — a fleet of cooperating AI engines that watch the market, form opinions, and manage real positions on Binance.*

<br>

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js_22-339933?style=for-the-badge&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React_18-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![SQLite](https://img.shields.io/badge/sql.js-003B57?style=for-the-badge&logo=sqlite&logoColor=white)

<br>

`Local LLMs (Ollama / llama.cpp)` · `Binance via ccxt` · `Puppeteer web research` · `Telegram approvals`

</div>

---

> [!WARNING]
> **This software places real orders with real money on Binance.** There is no paper/stub mode — live API keys are required. Crypto trading carries substantial risk of loss. Run it only with funds you can afford to lose, ideally start tiny, and keep human approval (`--approval`) on until you trust its behavior. **Nothing here is financial advice.**

---

## ✨ What it does

cryptoBot is not a single strategy — it's a **team of specialized AI engines**, each running on its own schedule, cooperating through a typed event bus. They search the web for news, compress it into structured sentiment, debate BUY/SELL/HOLD, time the entry on a live price feed, then babysit every open position until it closes.

```
                          ┌─────────────────────────────────────────┐
                          │            THE TRADE BRAIN                │
   🌐 Web (DuckDuckGo)    │            backend/index.ts               │     🟡 Binance
        │                 │      cron loops + typed event bus         │        │
        ▼                 └─────────────────────────────────────────┘        ▼
  ┌───────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐   ┌─────────────────┐
  │ RESEARCHER│──▶│ EXTRACTOR │──▶│ SELECTION│──▶│ ANALYST  │──▶│  GATES + ENTRY  │──▶ 💰 submitTrade()
  │  scrape   │   │  LLM →    │   │   LLM    │   │  LLM →   │   │  fee-edge /     │     (single choke point)
  │  articles │   │ sentiment │   │  rank    │   │ BUY/SELL │   │  size / timing  │
  └───────────┘   └───────────┘   └──────────┘   └──────────┘   └─────────────────┘
        ▲                                                                │
        │                                                                ▼
  ┌───────────┐                                                   ┌────────────┐
  │ DISCOVERER│  finds new coins ──▶ watchlist                    │  MONITOR   │  manages every
  │   LLM     │                                                   │   LLM      │  open position:
  └───────────┘                                                   │ SL/TP/CLOSE│  adjust · reduce · exit
                                                                  └────────────┘
                          ┌────────────┐
                          │  SUMMARY   │  read-only portfolio strategist → narrative briefing
                          │   LLM      │
                          └────────────┘
```

---

## 🧠 The engines

Each engine is an independent cron loop. They never trade directly — they **emit events** that the brain (`index.ts`) acts on, with `submitTrade()` as the single choke point for every real exchange order.

| Engine | Cadence | What it does |
|---|---|---|
| 🔬 **Pipeline** | `pipeline_cron` | The entry brain. **Researcher** (Puppeteer + DuckDuckGo) → **Extractor** (LLM compresses articles to sentiment) → **Selection** (LLM ranks) → **Analyst** (LLM emits BUY/SELL/HOLD + confidence + SL/TP). A BUY runs a gauntlet of gates before firing. |
| 🛰️ **Discoverer** | `discover_cron` | LLM-scored hunt for *new* candidate coins; approved picks feed the watchlist. |
| 👁️ **Monitor** | `monitor_cron` | The only engine that touches **held** coins — proposes SL/TP adjustments, CLOSE, or REDUCE on open positions. |
| 📊 **Summary** | `summary_cron` | Read-only portfolio strategist. Bundles the whole portfolio + live market context into a narrative briefing (health, risk, observations, suggestions). Never trades. |
| 🔁 **Position check** | every 30s | Reconciles open positions against live prices and exchange OCO fills. |
| 💬 **Agent** | on demand | A conversational, tool-calling assistant (the **Agent** page). Reads app data and takes *safe, non-trading* actions. No trade or settings-mutation tools. |

### 🎯 Smart entry timing

When `entry_timing_enabled`, a BUY signal isn't filled at the cron tick. It's registered as an **intent** that watches the live price feed and fires only on a pullback / in-band fill — or is cancelled by invalidate-drop, chase-cap, or TTL. The entry band is anchored to the **live** price at registration (the analyzed price is minutes-stale by the time the slow LLM pipeline finishes), while position sizing and the fee-edge gate stay on the decision-time price.

### 🛡️ The BUY gauntlet

Before any BUY becomes a real order it must clear: **max positions** · **not already held** · **no pending intent** · **min-USDC** · **position size** · and the **fee-edge gate** (`hasSufficientEdge` — expected move must beat round-trip fees). Coins already held are skipped by the pipeline entirely; they belong to the monitor.

> 💵 The quote/base currency is **USDC**, not USDT. Binance pairs are `<COIN>USDC`.

---

## 🧩 LLM integration

Every LLM call goes through `core/llm.ts` against **local OpenAI-compatible endpoints** (Ollama / llama.cpp) via the OpenAI SDK.

- **Shared endpoint catalog** — define named `{ baseURL, model, maxTokens, parallel }` endpoints once in *Settings → LLM Models*; each module selects one by id.
- **Per-module fallback** — if a module's primary endpoint *throws* (down/timeout/5xx), the same prompt retries once against a configured fallback. Each attempt is logged as its own `llm_calls` row.
- **Per-key concurrency gates** — each base URL is capped at one in-flight call by default (so a one-at-a-time local server is serialized), while different URLs run in parallel. Endpoints flagged `parallel` lift the cap, with optional `maxParallel` limits.
- **Full observability** — every call is recorded and live calls stream to the frontend's LLM activity view.

---

## 🏗️ Architecture

A monorepo of two independent Node packages that talk over **HTTP + a WebSocket** (`ws://localhost:3000/ws`) — no shared package.

```
cryptoBot/
├── backend/          Node.js + TypeScript (ESM) — the long-running trade brain
│   └── src/
│       ├── index.ts        ⭐ orchestrator: cron loops + event-bus handlers + submitTrade()
│       ├── core/           events bus · llm client · logger
│       ├── pipeline/ researcher/ extractor/ analyst/   the entry pipeline
│       ├── discoverer/ monitor/ summary/ entry/        the other engines
│       ├── agent/          tool-calling conversational assistant
│       ├── trader/         ccxt Binance wrapper (no stub mode)
│       ├── portfolio/      sizing · ATR SL/TP · OCO · fee-aware PnL · fee-edge gate
│       ├── market/         live price cache (WS) + OHLCV/indicators
│       ├── scraper/        Puppeteer-extra stealth browser
│       ├── telegram/       Telegraf approval bot + notifier
│       ├── db/             sql.js + versioned SQL migrations
│       └── api/            Express routes + WebSocket broadcast
└── frontend/         React + Vite + Tailwind — single-page app, no router
    └── src/pages/    Dashboard · Agent · Portfolio · Trade · Monitor · EntryDesk
                      Discover · Charts · LLM/Stats/Debug · Cache · TradingState · Settings · Logs
```

**Conventions worth knowing:** every module exposes its public API via `index.ts` (never import internals); cross-module side effects go through the typed event bus (`core/events.ts`); structured logging only (`logger.info('msg', { data })`); shared types in `backend/src/types.ts`.

### 🗄️ Database

SQLite via **sql.js** — held in memory, persisted to `data/*.db`, split across four files (`settings`, `trading`, `pipeline`, `cache`). Schema is driven by **versioned migrations**; a broken migration fails startup fast rather than half-migrating. Access only through the helpers (`queryAll`, `queryOne`, `runSQL`, `withTransaction`).

> ⚠️ `data/*.db` is root-owned and a running backend overwrites direct edits on its next save. **Never hand-edit the DB while the bot runs** — use `node tools/db.mjs exec`.

---

## 🚀 Quick start

### Prerequisites

- **Node.js 22+** (or Docker)
- A **Binance** account with API key + secret (trading enabled)
- A local **OpenAI-compatible LLM server** — [Ollama](https://ollama.com/) or llama.cpp
- *(optional)* a Telegram bot for trade approvals

### 1. Configure

```bash
cp .env.example .env   # then fill in the blanks
```

```ini
# Required
BINANCE_API_KEY=your_key
BINANCE_SECRET=your_secret
LLAMA_BASE_URL=http://host.docker.internal:11434/v1   # or http://localhost:11434/v1 bare-metal
LLAMA_MODEL=llama3

# Optional
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
APPROVAL_TIMEOUT_MINUTES=5
PORT=3000
```

Per-module LLM overrides (`EXTRACTOR_*`, `ANALYST_*`, `DISCOVERER_*`, `MONITOR_*`, `SUMMARY_*`, `AGENT_*`) all fall back to the `LLAMA_*` values — set them only if you want different models per engine. Most LLM config can also be changed live from **Settings → LLM Models**.

### 2a. Run with Docker (recommended)

```bash
docker-compose up
```
Backend on **:3000**, frontend on **:5173**, `data/` bind-mounted for persistence.

### 2b. Run bare-metal

```bash
# Backend  (from backend/)
npm install
npm run dev      # tsx watch — hot-reload on :3000

# Frontend (from frontend/, in a second terminal)
npm install
npm run dev      # Vite on :5173
```

Open **http://localhost:5173** 🎉

> 🔐 **Start safe:** launch the backend with `--approval` (or set `approval_required`) to require human approval for *every* trade signal until you trust it.

---

## 🛠️ Commands

| | Backend (`backend/`) | Frontend (`frontend/`) |
|---|---|---|
| **dev** | `npm run dev` — hot-reload :3000 | `npm run dev` — Vite :5173 |
| **start** | `npm start` | `npm run preview` |
| **build** | `npm run build` | `npm run build` |
| **check** | `npm run lint` — type-check (the only automated gate) | — |

> There is **no unit-test runner** — `npm run lint` (type-check) is the gate. Verify behavior by running the app.

### 🧰 Ops toolkit (`tools/`)

Two zero-setup CLIs wrap the fiddly bits (split DBs, root-owned files, the in-memory DB):

```bash
node tools/db.mjs  tables                          # inspect the SQLite databases
node tools/db.mjs  positions
node tools/db.mjs  query "SELECT coin,status,pnl FROM positions WHERE status='OPEN'"
node tools/db.mjs  exec  "DELETE FROM trades WHERE id=54" --db trading --yes   # destructive, auto-backs-up

node tools/app.mjs status                          # start / stop / logs / lint the dockerized app
node tools/app.mjs logs backend 200
node tools/app.mjs restart backend
```

See [AGENTS.md](./AGENTS.md) and [tools/README.md](./tools/README.md) for the full guide.

---

## 🔄 One-click updates

**Settings → System → Update app** pulls the latest `main` and rebuilds + restarts the whole stack from the dashboard — no SSH needed.

Since the backend runs in a container that the update tears down, it can't update itself directly. Instead the button drops a trigger file into a bind-mounted folder; a host-side **systemd watcher** sees it and runs [`update_run.sh`](./update_run.sh), so the rebuild survives `docker compose down`. No Docker socket is exposed to the app. The page shows an "Updating…" overlay and reloads once the new build is online.

Install the watcher once on the host, then enable the toggle in Settings:

```bash
sudo tools/updater/install-updater.sh
```

See [tools/updater/README.md](./tools/updater/README.md) for details.

---

## 🖥️ The dashboard

A single-page React app (no router — pages switch via `useState`) with **4 themes** and live data over WebSocket:

**Dashboard** · **Agent** (chat with the tool-calling assistant) · **Portfolio** · **Trade** · **Monitor** · **EntryDesk** (pending entry intents) · **Discover** · **Charts** (recharts candles) · **LLM / LLMStats / LLMDebug** (every call, live) · **CacheView** · **TradingState** · **Settings** · **Logs**

Saving settings reschedules the affected cron loops **live** — no restart needed.

---

## 📚 Further reading

- **[CLAUDE.md](./CLAUDE.md)** — deep architecture & code conventions
- **[AGENTS.md](./AGENTS.md)** — running & inspecting the app safely

---

<div align="center">

**Built with TypeScript, local LLMs, and a healthy respect for risk.**

⭐ *Trade responsibly.*

</div>
