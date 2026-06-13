import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Boot a real, isolated database for an integration test.
 *
 * The DB layer reads `DB_DIR` once at module-load time, so the env var must be
 * set *before* anything imports `db/connection`. We therefore point `DB_DIR` at
 * a fresh temp dir and pull the app modules in via dynamic `import()` from the
 * test's `before()` hook — never as a static top-level import. Node's test
 * runner isolates each test file in its own process, so each file gets its own
 * clean database and never sees another file's writes.
 *
 * Returns the live module namespaces the suites need, fully wired to the real
 * sql.js database (in-memory, mirrored to the temp dir).
 */
export async function bootApp() {
  process.env.LOG_LEVEL = 'error' // keep the structured logs out of the test output
  process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cryptobot-itest-'))

  // config/index.ts validates these at import time. The tests never make a real
  // exchange/LLM call, so dummy values are enough to satisfy the guard. (dotenv
  // won't override an already-set var, so this stays deterministic.)
  process.env.LLAMA_BASE_URL ??= 'http://localhost:0'
  process.env.LLAMA_MODEL ??= 'test-model'
  process.env.BINANCE_API_KEY ??= 'test-key'
  process.env.BINANCE_SECRET ??= 'test-secret'

  const db = await import('../../src/db/index.js')
  await db.initDB()

  const portfolio = await import('../../src/portfolio/index.js')
  const entry = await import('../../src/entry/index.js')
  const buy = await import('../../src/pipeline/buyEvaluation.js')
  const events = await import('../../src/core/events.js')

  return { db, portfolio, entry, buy, events }
}

/** List the table names defined in a specific named database. */
export function tablesIn(db: typeof import('../../src/db/index.js'), name: string): string[] {
  const res = db.getDB(name).exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  return (res[0]?.values ?? []).map(r => String(r[0]))
}
