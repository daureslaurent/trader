CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  total_value_usd REAL NOT NULL,
  holdings        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_created ON portfolio_snapshots(created_at);
