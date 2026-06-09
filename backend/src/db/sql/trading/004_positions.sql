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
  -- Exchange-side OCO protection (Binance order-list id + leg ids).
  oco_order_list_id TEXT,
  oco_sl_order_id   TEXT,
  oco_tp_order_id   TEXT,
  oco_status        TEXT NOT NULL DEFAULT 'NONE' CHECK(oco_status IN ('NONE','ACTIVE','FAILED')),
  oco_synced_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
