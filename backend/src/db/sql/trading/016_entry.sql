-- Entry-timing engine persistence.
--
-- entry_intents: the live "watching for a good fill" queue. One row per coin
-- (matching the in-memory Map). Rehydrated on startup so a restart doesn't drop
-- a deferred BUY — the engine resumes watching the price feed where it left off.
-- Rows are deleted when the intent fires or is cancelled.
CREATE TABLE IF NOT EXISTS entry_intents (
  id               TEXT PRIMARY KEY,
  coin             TEXT NOT NULL UNIQUE,
  signal           TEXT NOT NULL,          -- JSON-serialized Signal
  signal_price     REAL NOT NULL,
  target_price     REAL NOT NULL,
  invalidate_price REAL NOT NULL,
  chase_cap_price  REAL NOT NULL,
  notional_usdc    REAL NOT NULL,
  atr              REAL NOT NULL,
  created_at       INTEGER NOT NULL,       -- epoch ms
  expires_at       INTEGER NOT NULL        -- epoch ms
);

-- entry_events: append-only activity log (registered / filled / cancelled) that
-- backs the Entry Desk feed and its session stats. Survives restarts.
CREATE TABLE IF NOT EXISTS entry_events (
  id           TEXT PRIMARY KEY,
  coin         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK(type IN ('registered','filled','cancelled')),
  reason       TEXT,
  signal_price REAL NOT NULL,
  target_price REAL NOT NULL,
  price        REAL,
  slippage_pct REAL,
  created_at   INTEGER NOT NULL            -- epoch ms (EntryEvent.at)
);
CREATE INDEX IF NOT EXISTS idx_entry_events_created ON entry_events(created_at DESC);
