# Telegram Menu Refactor Design

## Goal
Replace the minimal 51-line Telegram bot with a full inline-keyboard menu system that exposes all frontend data through Telegram, plus push notifications for key events.

## Architecture

```
telegram/
  index.ts            → Public API: startTelegramBot(), sendApprovalMessage()
  bot.ts              → Telegraf setup, session middleware, error handling
  notifier.ts         ← NEW: subscribes to event bus, pushes messages to chat
  menu/
    index.ts          → MenuController: navigation logic, main menu renderer
    views/
      dashboard.ts    → Portfolio summary (total value, positions count, trades today, pending approvals, alerts)
      portfolio.ts    → Full positions table with live PnL, holdings list
      trades.ts       → Trade history, paginated 5/page
      decisions.ts    → Recent LLM signals
      pipeline.ts     → Pipeline cycles list with drill-down to full event chain
      settings.ts     → Settings viewer + inline editor for each key
      approvals.ts    → Pending approvals with approve/reject buttons
  components/
    pagination.ts     ← Shared pagination state and keyboard builder
    formatting.ts     ← Number/currency formatting, PnL color emoji, date formatting
```

## Data Flow

- Views fetch data via `queryAll`/`queryOne` (existing `db/` module) — no HTTP calls
- Mutations use `bus.emit()` or `runSQL()` — same as REST API
- Session stored in-memory via telegraf's `session()` middleware (single-user, no persistence needed)

## Session State

```typescript
interface MenuSession {
  menuStack: string[]                           // ['main'] or ['main', 'portfolio']
  pagination: Record<string, { page: number }>  // per-view pagination state
}
```

## Menu Navigation

- **Main Menu**: shown on `/start` and when pressing "Back" at top level
- Each view button sends `callback_data: "menu:<view_name>"`
- Every view has a "◀️ Back" button → pops `menuStack`
- Data-heavy views have "◀️ Prev" / "Next ▶️" pagination
- Main menu "Back" shows "🔄 Refresh" instead

### Callback Data Format

```
menu:portfolio          → navigate to portfolio view
page:trades:next        → next page of trades
approve:42              → approve trade 42
reject:42               → reject trade 42
setting:edit:interval   → open setting editor for interval_minutes
pipeline:cycle_abc123   → drill into pipeline cycle
```

## Views

### Main Menu
```
🤖 CryptoBot — Main Menu

📊 Dashboard
💼 Portfolio
📜 Trade History
🧠 LLM Decisions
🔬 Pipeline
⚙️ Settings
✅ Approvals
```

### 📊 Dashboard
4 stat cards + recent SL/TP alerts (up to 5):
```
📊 Dashboard
━━━━━━━━━━━━━━━━━━
💰 Portfolio: $12,450.32
📈 Open Positions: 3 / 5
🔄 Trades Today: 2
⏳ Pending Approvals: 1

🛑 SL Hit: BTC @ $59,800 (-2.3%)
✅ TP Hit: ETH @ $3,350 (+7.4%)
```

### 💼 Portfolio
```
💼 Portfolio — 3 Open Positions

#1 BTC  0.5 @ $61,200
   → $62,100  +$450  (+1.5%)
   SL: $59,800 (3.8%)  TP: $66,000 (6.3%)

Holdings: BTC 0.5, ETH 2.0, SOL 10, USDT 500
```

### 📜 Trade History
Last 50 trades, paginated 5/page:
```
📜 Trade History (Page 1/10)

✅ 12:30 BUY  0.5 BTC @ $61,200 — $30,600
✅ 11:15 SELL 2.0 ETH @ $3,120 — $6,240
⏳ 10:00 BUY  10 SOL @ $145   — $1,450

◀️ Prev  •  Page 1/10  •  Next ▶️
```
Status format: ✅ EXECUTED / ❌ FAILED / ⏳ PENDING

### 🧠 LLM Decisions
Last 20 decisions:
```
🧠 Recent Decisions

🟢 BTC → BUY  85% — Bullish momentum + breakout
⚪ ETH → HOLD 60% — Consolidating
🔴 SOL → SELL 72% — Resistance at $150
```

### 🔬 Pipeline
Recent cycles with status indicator. Tapping a cycle shows full drill-down:
```
🔬 Pipeline Cycles

⏳ BTC — Researching... (active)
🟢 ETH — BUY @ 85% (2m ago)
🟡 SOL — HOLD @ 60% (5m ago)
🔴 DOGE — ERROR (10m ago)
```

Cycle drill-down shows each stage:
- `research_started` / `research_completed` — article count, headlines, sentiment
- `extraction_started` / `extraction_completed` — articles with relevance, key points
- `analysis_started` / `analysis_completed` — market data, signal
- `signal_generated` — action, confidence, reason

### ⚙️ Settings
```
⚙️ Settings

Watchlist: BTC, ETH, SOL
Interval: 60 min
Min Confidence: 30%
Max Position: $100
✅ Approval Required
Stop Loss ATR: 2.0
Take Profit ATR: 4.0
Max Risk: 2%
Max Positions: 5

[✏️ Edit]
```
Edit flow: tap "✏️ Edit" → choose setting → enter new value → confirmation.

### ✅ Approvals
```
✅ Pending Approvals

⚠️ BUY 0.5 BTC — $30,600
Confidence: 85%
Reason: Bullish breakout
Expires: in 4m

[✅ Approve]  [❌ Reject]
```

## Push Notifications (`notifier.ts`)

Subscribes to event bus and formats messages:

| Trigger | Format |
|---|---|
| On initialization | `✅ CryptoBot started — monitoring markets` |
| `error` | `❌ Error: <message>` |
| `trade_executed` | `✅ <SIDE> <qty> <coin> @ $<price> — $<total>` |
| `stop_loss_hit` | `🛑 SL hit: <coin> @ $<price> (-<pnl>%)` |
| `take_profit_hit` | `✅ TP hit: <coin> @ $<price> (+<pnl>%)` |
| `approval_requested` | (existing `sendApprovalMessage` — kept as-is) |
| `portfolio_updated` | `📊 Portfolio: $<value> \| <positions> open \| <trades> today` |

Error handling: failed sends are logged, never crash the bot.

## Existing Code Preservation

- `sendApprovalMessage()` stays in `bot.ts` — unchanged signature
- `/approve` and `/reject` commands kept as keyboard shortcuts (also available via menu)
- All existing event bus integration remains untouched

## Edge Cases

- **No data yet**: Each view handles empty state gracefully ("No trades yet", "No positions open")
- **Bot token missing**: Same as current — `startTelegramBot()` returns null, no crash
- **Telegram API error**: Caught and logged, never propagates
- **Session corruption**: Reset `menuStack` to `['main']` on any unexpected state
- **Message too long**: Pagination keeps each message under Telegram's 4096 char limit
- **Callback query timeout**: Telegram requires response within a few seconds; we `answerCbQuery()` immediately, then edit message
