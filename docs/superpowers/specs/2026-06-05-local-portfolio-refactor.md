# Local Portfolio Refactor

## Problem

The portfolio system currently depends on Binance's `fetchBalance()` to determine what coins the user holds. This means:
- Any coin sitting on the Binance account is treated as a portfolio holding, even if bought elsewhere
- No buy price or buy date tracking — only entry_price from `positions` (for actively managed positions)
- Portfolio delta (current vs buy price) cannot be reliably computed
- The user cannot distinguish between "bought via this bot" and "has on exchange"

## Solution

Introduce a `portfolio_entries` table that serves as the source of truth for what the user holds. Entries are auto-populated from executed BUY trades and include buy price, buy date, and quantity. The portfolio state is computed from these local entries plus current market prices, with only the USDT cash balance fetched from Binance.

### Schema

```sql
CREATE TABLE portfolio_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  coin        TEXT NOT NULL,
  quantity    REAL NOT NULL,
  buy_price   REAL NOT NULL,
  buy_date    TEXT NOT NULL,
  status      TEXT DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
  source      TEXT DEFAULT 'trade',   -- 'trade' | 'manual'
  trade_id    INTEGER REFERENCES trades(id),
  created_at  TEXT DEFAULT (datetime('now'))
);
```

### Data Flow

**BUY trade executes:**
1. Trade executed on Binance (unchanged)
2. Position created for SL/TP tracking (unchanged)
3. `portfolio_entry` inserted with coin, quantity, execution price, date

**SELL / SL / TP hit:**
1. Trade executed on Binance (unchanged)
2. Position status updated (unchanged)
3. If SELL qty >= entry qty → portfolio_entry marked CLOSED
4. If SELL qty < entry qty → entry quantity reduced

**Portfolio state computation (trading loop):**
1. `SELECT * FROM portfolio_entries WHERE status = 'OPEN'`
2. Fetch current prices from Binance market data
3. Fetch USDT balance from Binance (for cash component)
4. Compute per-entry: delta_usd, delta_pct
5. Compute total: sum(current_value of entries) + USDT
6. Return PortfolioState for LLM consumption

### Delta Computation

```
per entry:
  current_value = current_price * quantity
  delta_usd = current_value - (buy_price * quantity)
  delta_pct = ((current_price - buy_price) / buy_price) * 100

total_value = sum(current_value for all entries) + USDT_balance
```

### Files Changed

| File | Change |
|------|--------|
| `backend/src/types.ts` | Add `PortfolioEntry` interface; update `PortfolioState` |
| `backend/src/db/schema.ts` | Add `portfolio_entries` table |
| `backend/src/portfolio/service.ts` | New: CRUD for entries, `getPortfolioState()` |
| `backend/src/portfolio/index.ts` | Re-export new service; remove old `computePortfolioState` |
| `backend/src/portfolio/prompts.ts` | Show per-entry delta in LLM prompt |
| `backend/src/index.ts` | Auto-create/close entries on trade execution; replace `fetchBalance` portfolio |
| `backend/src/api/routes.ts` | Rewrite `GET /api/portfolio` for local data; add POST/DELETE endpoints |
| `frontend/src/pages/Portfolio.tsx` | Show buy_date, buy_price, delta columns |
| `frontend/src/pages/Dashboard.tsx` | Adjust to new API shape |

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/portfolio` | OPEN entries with current prices, deltas, USDT balance |
| `POST` | `/api/portfolio/entry` | Manual entry (coin, qty, price, date) |
| `PATCH` | `/api/portfolio/entry/:id` | Edit entry |
| `DELETE` | `/api/portfolio/entry/:id` | Remove entry |
| `GET` | `/api/portfolio/history` | All entries including CLOSED |

### Unchanged

- `positions` table — still used for SL/TP risk management
- `market.ts` — technical indicators
- `risk.ts` — position sizing, SL/TP calculation
- `portfolio_snapshots` table — separate concern (can be fed from local data)
- LLM analyst — still receives PortfolioState, just with better data
