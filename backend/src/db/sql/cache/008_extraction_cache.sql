CREATE TABLE IF NOT EXISTS extraction_cache (
  url       TEXT PRIMARY KEY,
  coin      TEXT NOT NULL DEFAULT '',
  data      TEXT NOT NULL,
  cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_extraction_cache_coin ON extraction_cache(coin);
