CREATE TABLE IF NOT EXISTS position_reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  coin            TEXT NOT NULL,
  action          TEXT NOT NULL CHECK(action IN ('HOLD','CLOSE','REDUCE','ADJUST')),
  confidence      REAL NOT NULL,
  reasoning       TEXT NOT NULL,
  reduce_to_pct   INTEGER,
  new_stop_loss   REAL,
  new_take_profit REAL,
  market_data     TEXT NOT NULL DEFAULT '{}',
  model           TEXT,
  cycle_id        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_position_reviews_created ON position_reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_position_reviews_coin    ON position_reviews(coin);
