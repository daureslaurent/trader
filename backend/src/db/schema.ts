export const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coin TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  quantity REAL NOT NULL,
  price REAL,
  total REAL,
  signal_id INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','EXECUTED','FAILED')),
  approved INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coin TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('BUY','SELL','HOLD')),
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  context TEXT,
  triggered_trade_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (triggered_trade_id) REFERENCES trades(id)
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  total_value_usd REAL NOT NULL,
  holdings TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  coin       TEXT NOT NULL,
  cycle_id   TEXT NOT NULL,
  stage      TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_cycle ON pipeline_events(cycle_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_created ON pipeline_events(created_at DESC);

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
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('stop_loss_atr', '2'),
  ('take_profit_atr', '4'),
  ('max_risk_per_trade', '0.02'),
  ('max_open_positions', '5'),
  ('watchlist', '[]'),
  ('interval_minutes', '60'),
  ('min_confidence', '0.3'),
  ('max_position_size_usd', '100'),
  ('approval_required', 'false');
`
