CREATE TABLE IF NOT EXISTS position_adjustments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id     INTEGER NOT NULL,
  coin            TEXT NOT NULL,
  old_stop_loss   REAL,
  old_take_profit REAL,
  new_stop_loss   REAL,
  new_take_profit REAL,
  reasoning       TEXT,
  confidence      REAL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPLIED','REJECTED','EXPIRED')),
  model           TEXT,
  cycle_id        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_position_adjustments_status ON position_adjustments(status);
CREATE INDEX IF NOT EXISTS idx_position_adjustments_coin   ON position_adjustments(coin, created_at);
