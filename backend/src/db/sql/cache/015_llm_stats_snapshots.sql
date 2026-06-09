CREATE TABLE IF NOT EXISTS llm_stats_snapshots (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  module                   TEXT NOT NULL,
  model                    TEXT NOT NULL DEFAULT '',
  base_url                 TEXT NOT NULL DEFAULT '',
  call_count               INTEGER NOT NULL DEFAULT 0,
  error_count              INTEGER NOT NULL DEFAULT 0,
  total_duration_ms        INTEGER NOT NULL DEFAULT 0,
  total_prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  total_completion_tokens  INTEGER NOT NULL DEFAULT 0,
  total_thinking_tokens    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(module, model, base_url)
);
