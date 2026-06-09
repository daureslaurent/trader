CREATE TABLE IF NOT EXISTS sl_tp_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  coin        TEXT NOT NULL,
  stop_loss   REAL NOT NULL,
  take_profit REAL,
  event       TEXT NOT NULL DEFAULT 'update' CHECK(event IN ('open','update','close')),
  price       REAL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sl_tp_history_coin ON sl_tp_history(coin, created_at);
