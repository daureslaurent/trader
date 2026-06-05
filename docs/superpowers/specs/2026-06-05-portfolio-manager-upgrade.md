# Portfolio Manager Upgrade — Design Spec

## Goal
Transform the trading bot from a signal-based system into an autonomous portfolio manager with risk management, technical context, and portfolio-aware LLM decisions.

## Architecture

### New module: `backend/src/portfolio/`
```
portfolio/
  index.ts      — public API: checkOpenPositions(), getMarketContext(), analyzeAllocations()
  market.ts     — OHLCV fetch + technical indicators (RSI, SMA, ATR, trend regime)
  risk.ts       — position sizing formula, SL/TP level calculation
  prompts.ts    — build rich analyst prompt with full context
```

### New DB table: `positions`
```sql
CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  coin        TEXT NOT NULL,
  side        TEXT NOT NULL CHECK(side IN ('BUY')),
  quantity    REAL NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss   REAL NOT NULL,
  take_profit REAL,
  current_sl  REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED','SL_HIT','TP_HIT')),
  entry_id    INTEGER,
  exit_id     INTEGER,
  pnl         REAL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)
```

### New types in `types.ts`
```typescript
interface MarketContext {
  price: number; change24h: number; volume: number
  rsi14: number; sma7: number; sma25: number; sma99: number
  atr14: number
  trend: 'uptrend' | 'downtrend' | 'ranging'
  perf7d: number
  volatility: 'high' | 'normal' | 'low'
}

interface PortfolioState {
  totalValueUsd: number
  positions: { coin: string; allocationPct: number; pnlPct: number }[]
  diversificationScore: number
  openPositionCount: number
  maxOpenPositions: number
  targetAllocationPct: number
}

interface RiskConfig {
  stopLossAtrMultiplier: number
  takeProfitAtrMultiplier: number
  maxRiskPerTrade: number
  maxOpenPositions: number
}

interface PositionRecord {
  id: number; coin: string; side: 'BUY'
  quantity: number; entry_price: number
  stop_loss: number; take_profit: number | null
  current_sl: number; status: string
  pnl: number | null; created_at: string
}
```

### New settings keys
- `stop_loss_atr`: default "2"
- `take_profit_atr`: default "4"
- `max_risk_per_trade`: default "0.02"
- `max_open_positions`: default "5"

## Component Details

### `portfolio/market.ts`
- `fetchOHLCV(symbol, timeframe='1h', limit=168)` — 7 days of hourly data via ccxt
- `computeIndicators(ohlcv)` → returns RSI(14), SMA(7/25/99), ATR(14), trend regime, 7d perf
- `getMarketContext(symbol, price)` → fetches OHLCV, computes indicators, returns `MarketContext`

### `portfolio/risk.ts`
- `calculatePositionSize(price, atr, confidence, balance, settings)` → USD amount
  - Formula: `targetRisk = balance * settings.maxRiskPerTrade`
  - Risk-adjusted: `targetRisk * confidence`
  - Vol-adjusted: `baseQty = targetRisk / (atr * settings.stopLossAtrMultiplier)`
  - Capped at `settings.max_position_size_usd`
- `calculateStopLoss(entryPrice, atr, multiplier)` → price level
- `calculateTakeProfit(entryPrice, atr, multiplier)` → price level
- `checkStopLoss(currentPrice, position)` → `'HOLD' | 'SL_HIT' | 'TP_HIT'`

### `portfolio/index.ts`
- `checkOpenPositions()` — queries OPEN positions, checks current prices, emits `stop_loss_hit` or `take_profit_hit` for breached positions.
- `getPortfolioState(balance, marketData, positions)` → `PortfolioState` with correct allocation calculations (fixing current bug where `data.price` was used for all coins).
- `getMarketContext(symbol)` → fetches OHLCV + computes indicators.

### Rich Analyst Prompt (`portfolio/prompts.ts`)
System prompt sections:
1. Role: medium-term autonomous portfolio manager
2. Risk rules (non-negotiable constraints from settings)
3. Portfolio context (current allocations, diversification, open positions)
4. Market context (technical indicators, trend, volatility)
5. News context (extracted articles with sentiment/relevance)
6. Output format: JSON with action, confidence, reasoning, suggested_position_size_usd

The prompt is built once per coin, containing everything the LLM needs for that single decision.

### `analyst/service.ts` changes
Accepts `MarketContext` and `PortfolioState` alongside existing research. Calls `portfolio/prompts.ts` to build the prompt instead of `analyst/prompts.ts`.

## Trading loop flow (updated)

```
1. Check open positions → execute SL/TP hits (immediate market sells)
2. Fetch market data + balance (existing)
3. Compute portfolio state once (fix balance calc bug)
4. For each coin:
    a. researchCoin (existing)
    b. extractResearch (existing)
    c. getMarketContext (NEW)
    d. analyzeSignal(coin, marketContext, portfolioState, research) (updated)
    e. If BUY with sufficient confidence:
       - Calculate position size from risk engine
       - Place trade with SL/TP levels
       - Create position record
    f. If SELL:
       - If position open → close it (market sell)
       - Update position record with PnL
5. Snapshot portfolio (existing)
```

## Settings UI updates
Add risk management fields to Settings page:
- Stop Loss (ATR multiplier), Take Profit (ATR multiplier)
- Max Risk Per Trade (%), Max Open Positions
