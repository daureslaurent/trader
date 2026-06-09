CREATE TABLE IF NOT EXISTS portfolio_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  coin       TEXT NOT NULL,
  quantity   REAL NOT NULL,
  buy_price  REAL NOT NULL,
  buy_date   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
  source     TEXT NOT NULL DEFAULT 'trade' CHECK(source IN ('trade','manual','transfer')),
  trade_id   INTEGER REFERENCES trades(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_portfolio_entries_status ON portfolio_entries(status);
