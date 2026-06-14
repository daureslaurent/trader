-- Conversational Agent (the Agent page). A persisted chat between the user and an
-- LLM that can call read/safe-action tools against the app. One row per thread in
-- agent_conversations; the full transcript (including assistant tool_calls and the
-- tool results) lives in agent_messages so a conversation can be replayed straight
-- back into the model. The CREATE ... IF NOT EXISTS statements run on every startup,
-- so these tables are created on existing databases too.
CREATE TABLE IF NOT EXISTS agent_conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT 'New chat',
  -- Cumulative tokens (prompt + completion) across every model call in the thread — a
  -- running cost/throughput counter.
  total_tokens         INTEGER NOT NULL DEFAULT 0,
  -- Peak single-request tokens (prompt + completion) of the most recent turn. Because
  -- each turn resends the full history, this grows with the conversation and is the
  -- number to watch against the model's context window.
  last_context_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_updated ON agent_conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
  content         TEXT,
  -- JSON-encoded OpenAI tool_calls array on assistant messages that requested tools.
  tool_calls      TEXT,
  -- Links a 'tool' result message back to the assistant tool_call it answers.
  tool_call_id    TEXT,
  -- Tool name for 'tool' messages.
  name            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(conversation_id, id);
