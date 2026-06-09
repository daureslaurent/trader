CREATE TABLE IF NOT EXISTS decisions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  coin               TEXT NOT NULL,
  action             TEXT NOT NULL CHECK(action IN ('BUY','SELL','HOLD')),
  reason             TEXT NOT NULL,
  confidence         REAL NOT NULL,
  context            TEXT,
  triggered_trade_id INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (triggered_trade_id) REFERENCES trades(id)
);

CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at);
