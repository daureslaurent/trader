-- Portfolio-summary engine output. One row per summary run: an LLM narrative read
-- of the whole portfolio plus structured fields, kept on a retention window
-- (summary_retain_days). The snapshot column stores the JSON data fed to the LLM
-- so a summary stays interpretable even as live prices move on.
CREATE TABLE IF NOT EXISTS portfolio_summaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  summary       TEXT NOT NULL,
  what_happened TEXT,
  health        TEXT,
  risk_level    TEXT,
  observations  TEXT,
  suggestions   TEXT,
  snapshot      TEXT NOT NULL DEFAULT '{}',
  model         TEXT,
  cycle_id      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_portfolio_summaries_created ON portfolio_summaries(created_at DESC);
