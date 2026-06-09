# Design Issues — To Fix

## Priority Overview

| Priority | Label | Meaning |
|----------|-------|---------|
| **P0** | Must fix | Direct financial loss or data corruption |
| **P1** | High risk | Incorrect behavior, stale state, or crash data loss |
| **P2** | Medium | Correctness or UX issues |
| **P3** | Low | Type hygiene, minor refactors |

**Recommended order:** P0 first (all before real funds), then P1, then P2/P3. Within P0: #3 → rest (many fixes need transactions).

### Dependency Graph

```
#3 (transactions)  ──blocks── #8 (debounced save) ──improves── #9 (OCO delay)
                    ──blocks── #6d (USDC crash window)
#1 (LLM split)     ──affects── #15 (order book placement)
#9 (OCO delay)     ──mitigates── #6 (faster detection = less wrong state)
```

---

## [P0] #1. LLM is Asked to Do Too Much

The single LLM call in `analyzeSignal()` (`backend/src/analyst/service.ts:92-101`) is responsible for **all** of these decisions at once:

- **Market regime classification** — is the market trending, ranging, or reversing?
- **Technical analysis** — interpreting RSI, SMA alignment, ATR volatility
- **News sentiment integration** — weighing articles against price action
- **Trade direction** — BUY / SELL / HOLD
- **Confidence calibration** — HIGH / MEDIUM / LOW
- **Position sizing** — via `stop_loss_pct` / `take_profit_pct` that feeds into risk
- **Risk/reward setting** — SL and TP distances from entry
- **Horizon judgement** — short / medium / long (when `default_horizon = 'auto'`)

### Why this is a problem

**a) Conflicting objectives dilute quality**

Each task has different optimal LLM parameters. Classification (regime, sentiment) benefits from low temperature (0.2) and constrained output. Creative SL/TP setting benefits from slightly higher temperature to explore ranges. The single call at temperature 0.3 (`backend/src/analyst/service.ts:98`) is a compromise that serves none of these tasks optimally.

**b) No specialization — garbage in, garbage out**

If the LLM misclassifies the market regime, the trade direction and SL/TP are both wrong. There is no isolation of concerns. A specialized "market regime" agent could use deterministic rules (trend lines, volume profile) while a separate "execution" agent handles the trade parameters.

**c) The prompt is a kitchen sink**

The system prompt in `backend/src/portfolio/prompts.ts:110-170` packs together:
- Decision rules
- Technical signal interpretation
- Portfolio state
- Risk reference tables
- Per-horizon SL/TP guidelines
- JSON output schema
- Confidence definitions

This is ~3000 tokens of instruction before the LLM even sees the data. Long prompts increase hallucination rates and decrease instruction-following reliability, especially on smaller open-source models.

**d) The monitor module has the same problem**

`backend/src/monitor/service.ts:100-109` uses a single LLM call to decide:
- Whether to hold, close, reduce, or adjust
- New SL/TP prices (as absolute USD values)
- A confidence score

The `rescalePrice()` hack (`backend/src/monitor/service.ts:58-68`) exists precisely because the LLM is unreliable at outputting correct decimal-scaled prices for this compound task. This is a symptom of asking too much.

**e) The discoverer also follows this pattern**

`backend/src/discoverer/prompts.ts:15-34` uses one LLM call to evaluate market data AND news AND produce a score. Same single-call-for-compound-judgement pattern.

### What to do instead

**Split the analyst pipeline into specialized agents:**

```
Phase 1: Market Regime Agent
  Input:  OHLCV data, RSI, SMA, ATR, volume
  Output: { trend: 'uptrend' | 'downtrend' | 'ranging',
             volatility: 'high' | 'normal' | 'low',
             regime_confidence: 0.0-1.0 }

Phase 2: Sentiment Agent
  Input:  Extracted articles
  Output: { aggregated_sentiment: 'positive' | 'negative' | 'neutral',
             key_narratives: string[],
             sentiment_confidence: 0.0-1.0 }

Phase 3: Decision Agent
  Input:  Regime + Sentiment + Portfolio state + Position context
  Output: { action: 'BUY' | 'SELL' | 'HOLD',
             confidence: 'HIGH' | 'MEDIUM' | 'LOW',
             reason: string }

Phase 4: Risk Agent
  Input:  Action + Regime + Position size
  Output: { stop_loss_pct: number, take_profit_pct: number,
             horizon: 'short' | 'medium' | 'long' }
```

Each agent has:
- A narrow, well-defined task
- Short, focused prompts (200-400 tokens)
- Appropriate temperature (0.2 for classification, 0.4 for generation)
- Its own retry logic and error fallback
- The `llmChat` wrapper already logs every call, so debugging costs is easy

Alternative (cheaper): Replace agents 1 and 4 with deterministic rules. Market regime can be derived from SMA alignment + RSI + ATR bands deterministically. SL/TP can be computed from ATR (as the existing `calculateStopLoss`/`calculateTakeProfit` already do — `backend/src/portfolio/risk.ts:42-53`). Only the decision and sentiment truly need LLM reasoning.

---

## [P1] #2. Position Monitor LLM Asks for Absolute Prices and Has No Churn Protection

The position monitor (`backend/src/monitor/service.ts`) has its own set of LLM-specific issues beyond the general "too many tasks" problem covered in #1.

### 2a. Asks the LLM for absolute USD prices

The monitor prompt (`backend/src/monitor/prompts.ts:110-118`) asks the LLM to output `new_stop_loss` and `new_take_profit` as absolute USD prices:

```json
{
  "action": "ADJUST",
  "new_stop_loss": 1.1650,
  "new_take_profit": null
}
```

LLMs are notoriously bad at outputting precise floating-point numbers at the correct decimal scale. This is why `rescalePrice()` exists (`backend/src/monitor/service.ts:58-68`) — a heuristic that tries powers of 10 until the price looks reasonable.

**Why it's unreliable:**
- A coin at $0.0035 and a coin at $35.00 need very different decimal scales
- The prompt warns "Example: if Current = $1.1787, a valid stop is 1.1500 — NOT 11500" — telling the LLM what NOT to do is a weak constraint
- `rescalePrice()` assumes the correct scale is within 5 orders of magnitude from the reference (0.5× to 1.5×). For an OTM coin at $0.00001 with SL at $0.000009, this could mis-scale
- The check `ratio >= 0.1 && ratio <= 5` skips rescaling for values within 10%-500% of reference — too wide to catch obvious errors

**Fix:** Change the interface to ask for **percentages** instead of absolute prices:

```json
{
  "action": "ADJUST",
  "confidence": 0.8,
  "reasoning": "...",
  "new_stop_loss_pct": -3.5,
  "new_take_profit_pct": 8.0
}
```

Then compute `newStopLoss = currentPrice * (1 + new_stop_loss_pct / 100)` in code. This eliminates the decimal-scale problem entirely. `rescalePrice()` can be removed.

### 2b. No ADJUST churn protection

If the LLM proposes `ADJUST` every monitor cycle with tiny SL/TP changes (e.g., trailing SL up by 0.1%), each one triggers an OCO cancel + replace (`replaceProtection` in `portfolio/service.ts:374-401`). This costs Binance API weight and, more importantly, means the position goes briefly unprotected between the cancel and the new placement.

`validateSlTpAdjustment` (`portfolio/risk.ts:96`) has a `same()` function that treats values within ~0.0001% as unchanged, but the LLM can easily propose changes larger than this threshold.

**Fix:** Add a debounce/cooldown to ADJUST proposals:
- Track the last time an ADJUST was applied for each coin
- Reject new ADJUST proposals within N hours of the last one (configurable, default 24h)
- Alternative: require the new SL/TP to be at least X% different from current before accepting (e.g., SL must move ≥ 0.5%)

### 2c. Wrong position age for multi-entry builds

The monitor query (`backend/src/monitor/service.ts:260-269`) uses `MIN(buy_date)`:

```sql
SELECT
  coin,
  SUM(quantity) AS quantity,
  SUM(quantity * buy_price) / SUM(quantity) AS avg_buy_price,
  MIN(buy_date) AS earliest_date
FROM portfolio_entries WHERE status = 'OPEN' AND coin != 'USDC'
GROUP BY coin
```

Then `ageHours` is computed from `earliest_date` (line 309):

```ts
const ageMs = Date.now() - new Date(entry.earliest_date + 'T00:00:00Z').getTime()
const ageHours = ageMs / (1000 * 60 * 60)
```

If a position was partially reduced (e.g., a REDUCE or partial SL hit), then later re-added (averaging down or adding on pullback), `MIN(buy_date)` returns the **original** entry date — making the position look much older than it is. This feeds into the LLM prompt as `ageHours`, which the LLM uses for horizon-sensitive decisions. A position opened yesterday with a add today looks like "3 months old" from the MIN, so the LLM treats it as a long-term hold.

**Fix:** Use a weighted average of buy dates instead of MIN:

```sql
MIN(buy_date) AS earliest_date
```
→
```sql
SUM(quantity * julianday(buy_date)) / SUM(quantity) AS avg_date_jd
```

Then convert `avg_date_jd` back to a date in code. Or simply use `MAX(buy_date)` (the most recent entry), which better represents the position's current cost basis.

### 2d. No retry on LLM API errors (only parse errors retried)

The retry loop in `monitorCoin()` (`backend/src/monitor/service.ts:99-129`) only retries on parse errors:

```ts
try {
  raw = parseReview(content)
} catch (err) {
  if (attempt === 0) { continue }
  throw err
}
```

If `llmChat` itself throws (network error, API down, timeout), the exception propagates out of the for loop entirely — no retry. The caller's `.catch()` at line 357 logs the error and returns null, skipping the review entirely.

**Fix:** Wrap the `llmChat` call in the try/catch too, or add a try/catch around the entire for-loop body.

### 2e. Cascading CLOSE/REDUCE with no rejection memory

The prompt includes the last 3 reviews (line 88-90):

```ts
const history = queryAll(
  'SELECT * FROM position_reviews WHERE coin = ? ORDER BY created_at DESC LIMIT 3',
  [ctx.coin],
)
```

But the history only contains the review data (action, confidence, reasoning, market_data at the time). It does **not** include whether the action was acted upon or rejected. If the LLM recommends CLOSE, the human rejects it, next cycle the LLM sees the same position in a similar state and recommends CLOSE again.

**Fix:** Add an `outcome` field to `position_reviews` (`applied`, `rejected`, `expired`, `ignored`). Include it in the history context so the LLM can see "last time I recommended CLOSE but it was rejected because...".

---

## [P0] #3. No Transaction Atomicity

**Affects:** #8, #6d (these fixes depend on transactions existing)

Trade execution in `submitTrade()` (`backend/src/index.ts:527-601`) performs 3-4 separate database writes:

1. `INSERT INTO trades` (line 543)
2. `INSERT INTO positions` (line 554)
3. `recordPositionOpen` → `INSERT INTO sl_tp_history` (line 558)
4. `addEntry` → `INSERT INTO portfolio_entries` (line 572)
5. `reduceEntryQuantity` → `UPDATE portfolio_entries` (line 575)

If the process crashes between steps 3 and 4, the portfolio ledger shows USDC as spent but no entry exists for the coin. The `positions` table shows an open position but `portfolio_entries` shows no holding.

The sell path has the same problem (lines 336-347): position is marked CLOSED before portfolio entries are updated.

The OCO-reconcile exit path (`closePositionFromExit` in `portfolio/service.ts:301-336`) also has the same problem: coin entries closed (line 316) before USDC is credited (line 320).

**Fix:** Expose a transaction API from `db/helpers.ts` — `beginTransaction()`, `commit()`, `rollback()`. sql.js supports `db.exec('BEGIN')` / `COMMIT` / `ROLLBACK`. Wrap all multi-table writes in transactions. Key call sites to wrap:
- `submitTrade()` in `index.ts` — BUY and SELL paths
- `closePositionFromExit()` in `portfolio/service.ts`
- `tradingLoop()` SELL path (lines 336-347 in `index.ts`)
- `executeFallbackExit()` (lines 722-753 in `index.ts`)

---

## [P0] #4. Partial Fill Leads to Overspend on Buys

In `backend/src/trader/service.ts`, the buy path (`executeTrade`) uses:

```
IOC limit order → if unfilled → market order with full cost
```

If the IOC fills 40% at the limit price, the fallback market order (`createMarketOrderWithCost`) uses the **full original cost** (`signal.quantity * analysis.bestAsk`), not the remaining 60%. This means the bot spends ~1.4× the intended amount.

**Fix:** After the IOC attempt, check `result.filled`. If `filled < signal.quantity`, create the market order with `cost * (1 - filled / signal.quantity)`. If `filled >= signal.quantity`, skip the market fallback entirely.

---

## [P0] #5. Negative Stop-Loss Possible

In `backend/src/portfolio/risk.ts:48`:

```ts
export function calculateStopLoss(entryPrice: number, atr: number, settings: BotSettings): number {
  return entryPrice - (atr * settings.stop_loss_atr)
}
```

If `atr * stop_loss_atr > entryPrice`, the SL goes negative. This means `checkPosition()` will never trigger SL_HIT because `currentPrice > 0 > negative_SL` is always false. The position can never be stopped out.

**Fix:** Clamp at `entryPrice * 0.01` (1% below entry):

```ts
const raw = entryPrice - (atr * settings.stop_loss_atr)
return Math.max(raw, entryPrice * 0.01)
```

---

## [P0] #6. USDC Not Credited Back to Portfolio After OCO Exit

**Depends on:** #3 (transaction fix would prevent crash-window data loss in item d)

When an OCO fills on Binance and `closePositionFromExit()` (`backend/src/portfolio/service.ts:301-336`) runs, it attempts to credit the proceeds back to the USDC portfolio entry:

```ts
const proceeds = exit.fillPrice * exit.fillQty
const usdtEntry = getUsdtEntry()
if (usdtEntry) increaseEntryQuantity(usdtEntry.id, proceeds)
```

**Failure modes where USDC is silently lost:**

**a) `getUsdtEntry()` returns null**

The USDC entry is seeded once by `seedUsdtIfAbsent()` on startup or during the first pipeline run (`backend/src/index.ts:241`). If something deletes or closes this entry (a bug, manual DB edit, or migration issue), `getUsdtEntry()` returns null, `increaseEntryQuantity` is never called, and the proceeds are lost. The function still returns `true` — no error is logged.

**Fix:** `closePositionFromExit` should call `seedUsdtIfAbsent(0)` as fallback if `getUsdtEntry()` returns null, then retry. Or make `getUsdtEntry()` auto-seed.

**b) `fillQty` from `fetchOco` is unreliable**

`fetchOco()` (`backend/src/trader/oco.ts:172`) reports the fill quantity from `o.filled`. For a STOP_LOSS_LIMIT leg (the SL side of an OCO), `ccxt` may report the quantity in the base currency but the fill status can be ambiguous:

```ts
const isFilled = (o: any) => o && (o.status === 'closed' || (o.filled ?? 0) > 0 && o.status !== 'open' && o.status !== 'canceled')
```

A partially filled stop-limit order with `o.filled > 0` but status still `'open'` passes this check. The reported `fillQty` reflects only the partial fill, not the full position. `closePositionFromExit` then credits USDC for only part of the position and closes the remaining portfolio entries — the unrecovered portion is lost.

**Fix:** In `reconcileOpenPositions` (`portfolio/service.ts:446-456`), before calling `closePositionFromExit`, verify that `oco.fillQty === pos.quantity` (within precision). If `fillQty < pos.quantity`, skip the close and retry next cycle — the OCO isn't fully done yet. A partial fill is rare and the 2-minute retry is fine.

**c) `fillPrice` from `fetchOco` may not match actual execution**

For the SL leg, `o.average` reports the average fill price of the stop-limit order. But if the limit leg fills at a different price than the trigger (common during fast moves), the proceeds calculation `fillPrice * fillQty` differs from what the exchange actually credited. For the TP leg (`LIMIT_MAKER`), `o.average` equals the limit price, which is correct.

**Fix:** Add a `proceeds` field to the exit event and log the expected vs fill-based proceeds. Not easily fixable without Binance trade history API — accept the approximation but make it visible.

**d) Coin entries closed before USDC is credited (crash window)**

`closePositionFromExit` closes coin entries first (line 316), then credits USDC (line 320). A crash between these two steps leaves the portfolio in an inconsistent state — the coin is no longer held but USDC was never replenished. Same root cause as issue #3.

**Fix:** Same as #3 — wrap in a SQL transaction.

---

## [P1] #7. No `pipeline_completed` Event

The `tradingLoop()` function (`backend/src/index.ts:214-382`) emits `portfolio_updated` on line 380 but never emits a terminal pipeline event. The frontend has no way to know a full cycle finished — it only sees individual per-coin `signal_generated` and `trade_executed` events.

**Fix:** At the end of `tradingLoop()` (after the snapshot insert at line 378, before the final log at line 381), add:

```ts
bus.emit('pipeline_completed', {
  cycle_id: runCycleId,
  total_value_usd: snapshotTotal,
  trades_initiated: tradesInitiated,
  holdings,
})
```

Also broadcast it via `broadcast('pipeline_completed', { ... })` so the frontend WebSocket picks it up.

---

## [P1] #8. Debounced Save Risk

**Depends on:** #3 (transaction API provides a clean hook to trigger sync saves)

`backend/src/db/connection.ts:90-93` debounces `saveDB()` by 2 seconds. If the process crashes (SIGKILL, power loss), up to 2 seconds of trades, positions, and portfolio entries are lost.

**Fix:** Call `saveDB()` synchronously after every write to these tables — they are **trade-critical**:
- `trades` — INSERT and UPDATE
- `positions` — INSERT and UPDATE
- `portfolio_entries` — INSERT and UPDATE (all of: `addEntry`, `reduceEntryQuantity`, `increaseEntryQuantity`, `closeEntry`, `updateEntryQuantity`)
- `portfolio_snapshots` — INSERT

The debounce can remain for **non-critical** tables:
- `pipeline_events` — informational, replayable
- `decisions` — historical, replayable
- `llm_calls` — debugging only
- `position_reviews` — historical, replayable
- `position_adjustments` — historical, replayable
- `sl_tp_history` — audit trail, replayable
- `coin_discoveries` — informational
- `ohlcv_cache` — refetchable

Implementation: Add a `saveDB(name?: string)` call at the end of `runSQL` when the inferred table is in the critical list. Use `saveDB(dbName)` to target only the affected DB file rather than dumping all 4.

---

## [P1] #9. OCO Fill Detection Has Up-to-2-Minute Delay

`reconcileOpenPositions()` (`backend/src/portfolio/service.ts:430`) runs every 2 minutes via `POSITION_CHECK_INTERVAL_MS` (`backend/src/index.ts:46`). When an OCO leg fills on Binance (SL or TP hit), the bot does **not** receive a callback or webhook — it only discovers the fill on the next reconciliation cycle.

**Problems caused by this delay:**
- **Stale UI**: The frontend shows the position as open, with incorrect PnL and portfolio value
- **Monitor interference**: The position monitor can review and propose actions for a coin that was already closed on exchange (partially mitigated by the `stillOpen` check in `monitor/service.ts:192-199`, but the LLM call already ran by then — wasted tokens and latency)
- **Stale price subscription**: The price cache keeps fetching prices for a coin no longer held
- **Missed re-entry**: If the bot would want to re-buy after a TP hit, it can't until the next reconcile cycle

**Fix:** Options ranked by effort and recommendation:

| Approach | Effort | Latency | Complexity | Recommendation |
|---|---|---|---|---|
| **Shorten interval** — reduce `POSITION_CHECK_INTERVAL_MS` to 15-30s | Trivial | ~15s | None | Quick win, do first |
| **Poll on trade activity** — trigger a reconcile after each `trade_executed` or price update | Low | ~1s | Low | Good follow-up |
| **Binance WebSocket user stream** — subscribe to `executionReport` events for real-time OCO fill detection | Medium | Real-time | Medium (needs listenKey management + WebSocket reconnection) | Best long-term |
| **Webhook from Binance** — Binance can POST to a callback URL | High | Real-time | High (needs public endpoint + auth) | Not recommended |

Recommended approach: Do "shorten interval" first (5-min change), then "Binance WebSocket user stream" as a proper fix. The bot already stores the API key/secret — create a listenKey on startup, subscribe to the user data stream, and emit `oco_filled` events on `executionReport` for OCO legs.

---

## [P2] #10. Telegram Approval Responds Before Trade Completes

In `backend/src/telegram/bot.ts:51-56`, the `/approve` command handler emits `trade_approved` and immediately replies "Approved" — but `submitTrade` (triggered by `bus.on('trade_approved')` in `index.ts:603-613`) is async. The user gets a success message before the trade actually executes, and has no way to know if it failed.

**Fix:** Instead of emitting `trade_approved` and relying on the event handler, have the Telegram bot handler call `submitTrade()` directly and await it. Then reply with either "✅ Trade executed" or "❌ Trade failed: {reason}". The event-based path can remain for WebSocket/API approvals.

---

## [P2] #11. Migration Errors Silently Caught

All migrations in `backend/src/db/migrations.ts` wrap SQL in try/catch with only a `logger.warn`. If a migration fails (disk full, constraint violation, syntax error), the app continues in an unpredictable state. There is no migration versioning — every migration runs on every startup.

**Fix:** Add a `schema_version` table if it doesn't exist. Each migration function checks its version before running. Remove the blanket try/catch — let migration failures crash the startup so they can't be ignored. Wrap migrations in transactions for atomicity.

```ts
// Version-tracking migration pattern
function migrateV2_addNewColumn() {
  if (getAppliedVersion() >= 2) return
  runSQL('BEGIN')
  runSQL('ALTER TABLE positions ADD COLUMN new_col TEXT')
  setAppliedVersion(2)
  runSQL('COMMIT')
}
```

---

## [P2] #12. No Rate Limiting Awareness

The bot has no awareness of Binance rate limits. Batch operations (fetching market data for 20+ coins in parallel, placing multiple OCOs) could trigger `429 Too Many Requests`. The code has no exponential backoff or request queue.

**Fix:** Add a rate limiter wrapper in `backend/src/trader/service.ts` around the ccxt exchange instance. Use a simple token-bucket with 10 requests/second (Binance Spot allows 1200 weight per minute — track weight from response headers). The wrapper should:

1. Intercept all exchange calls via a Proxy around the ccxt `Exchange` instance
2. Check weight from `response.info` headers (`X-MBX-USED-WEIGHT-(UID)`)
3. If approaching limit, delay before sending
4. On 429, log the headers and back off exponentially (1s → 2s → 4s → max 30s)

This should be a single function `withRateLimit(exchange)` that wraps the exchange object, not scattered throughout the code.

---

## [P2] #13. Two Different `MarketData` Interfaces

`backend/src/types.ts:142` defines `MarketData` as:

```ts
interface MarketData { symbol: string; price: number }
```

But `backend/src/trader/types.ts` has a different `MarketData` that also includes `change24h`, `volume`, `bid`, `ask`, etc. The `portfolio/service.ts` import depends on which version it picks up. This causes confusion and potential type errors.

**Fix:** Delete the minimal `MarketData` from `src/types.ts` and import the richer version from `trader/types.ts` everywhere. Or, if circular imports are an issue, merge both into `src/types.ts` with all fields as optional:

```ts
interface MarketData {
  symbol: string
  price: number
  change24h?: number
  volume?: number
  bid?: number
  ask?: number
}
```

---

## [P3] #14. `enrichPortfolioEntriesWithPrices()` Returns Extra Fields Not in Type

`backend/src/portfolio/service.ts:486-506` enriches `PortfolioEntry[]` with `current_price`, `delta_usd`, `delta_pct` but the `PortfolioEntry` type (`backend/src/types.ts:161-174`) doesn't include these as optional fields. The runtime works but TypeScript can't catch mismatches.

**Fix:** Add them to the type as optional:

```ts
interface PortfolioEntry {
  // ... existing fields ...
  current_price?: number
  delta_usd?: number
  delta_pct?: number
}
```

---

## [P3] #15. Order Book Analysis Uses Placeholder Quantity

In `backend/src/analyst/service.ts:82`:

```ts
orderBook = analyzeOrderBook(book, market.price > 0 ? 100 / market.price : 1)
```

The quantity `100 / market.price` is ~$100 worth — an arbitrary placeholder. The actual position size is calculated later in `tradingLoop()` via `calculatePositionSize()`. The order book analysis (VWAP, price impact, suggested limit price) is therefore computed for a different amount than the actual trade.

**Fix:** Either (a) move order book analysis after position sizing (requires restructuring the pipeline to pass calculated qty into the analysis phase), or (b) accept it as an approximation but document the limitation.
