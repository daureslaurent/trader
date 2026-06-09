CREATE TABLE IF NOT EXISTS ohlcv_cache (
  cache_key  TEXT PRIMARY KEY,      -- "BTC/USDC|1h"
  symbol     TEXT NOT NULL,
  timeframe  TEXT NOT NULL,
  data       TEXT NOT NULL,         -- JSON array of [time, open, high, low, close, volume]
  fetched_at INTEGER NOT NULL       -- epoch ms of last Binance fetch
);
