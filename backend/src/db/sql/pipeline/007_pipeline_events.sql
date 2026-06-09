CREATE TABLE IF NOT EXISTS pipeline_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  coin       TEXT NOT NULL,
  cycle_id   TEXT NOT NULL,
  stage      TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_cycle           ON pipeline_events(cycle_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_created         ON pipeline_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_created  ON pipeline_events(created_at);
