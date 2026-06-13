-- Persistent per-coin scratchpad written by the monitor LLM itself.
-- Survives the 3-review prompt window; cleared when the position closes.
CREATE TABLE IF NOT EXISTS monitor_notes (
  coin       TEXT PRIMARY KEY,
  notes      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
