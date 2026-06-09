CREATE TABLE IF NOT EXISTS llm_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  module            TEXT NOT NULL,
  model             TEXT NOT NULL,
  base_url          TEXT NOT NULL DEFAULT '',
  system_prompt     TEXT NOT NULL DEFAULT '',
  user_prompt       TEXT NOT NULL DEFAULT '',
  response          TEXT,
  error             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  coin              TEXT,
  cycle_id          TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_module  ON llm_calls(module);
