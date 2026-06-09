CREATE TABLE IF NOT EXISTS coin_discoveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  coin        TEXT NOT NULL,
  score       REAL NOT NULL,
  reasoning   TEXT NOT NULL,
  market_data TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','auto_added')),
  cycle_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discoveries_created ON coin_discoveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_status  ON coin_discoveries(status);
