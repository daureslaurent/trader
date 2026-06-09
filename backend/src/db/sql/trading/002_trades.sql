CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  coin         TEXT NOT NULL,
  side         TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  quantity     REAL NOT NULL,
  price        REAL,
  total        REAL,
  fee_cost     REAL NOT NULL DEFAULT 0,
  fee_currency TEXT NOT NULL DEFAULT 'USDC',
  signal_id    INTEGER,
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','EXECUTED','FAILED')),
  approved     INTEGER,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_trades_status  ON trades(status);
