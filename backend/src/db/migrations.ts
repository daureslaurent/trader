import { Database as SqlJsDatabase } from 'sql.js'
import { logger } from '../core/logger.js'

// ── Migration versioning ────────────────────────────────────────────────────
// Each migration is numbered. On startup we check which have already run and
// skip them. Migration errors crash startup (fail-fast) so they can't be silently
// swallowed — a half-migrated DB is worse than a blocked start.

function getAppliedVersion(db: SqlJsDatabase, ns: string): number {
  db.run(`CREATE TABLE IF NOT EXISTS schema_version (
    ns      TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (ns)
  )`)
  const rows = db.exec(`SELECT version FROM schema_version WHERE ns = '${ns}'`)
  return (rows[0]?.values?.[0]?.[0] as number) ?? 0
}

function setAppliedVersion(db: SqlJsDatabase, ns: string, version: number): void {
  db.run(`INSERT OR REPLACE INTO schema_version (ns, version) VALUES ('${ns}', ${version})`)
}

function migrate(
  db: SqlJsDatabase,
  ns: string,
  version: number,
  fn: (db: SqlJsDatabase) => void,
): void {
  if (getAppliedVersion(db, ns) >= version) return
  logger.info('Running migration', { ns, version })
  db.exec('BEGIN')
  try {
    fn(db)
    setAppliedVersion(db, ns, version)
    db.exec('COMMIT')
    logger.info('Migration applied', { ns, version })
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    // Crash startup — a broken migration must be visible, not swallowed.
    throw new Error(`Migration ${ns} v${version} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function runMigrations(dbs: Record<string, SqlJsDatabase>): void {
  const trading  = dbs['trading']
  const cache    = dbs['cache']
  const settings = dbs['settings']

  // ── Cache DB ──────────────────────────────────────────────────────────────

  migrate(cache, 'cache', 1, (db) => {
    try { db.run("ALTER TABLE extraction_cache ADD COLUMN coin TEXT NOT NULL DEFAULT ''") } catch { /* already exists in fresh schema */ }
    db.run('CREATE INDEX IF NOT EXISTS idx_extraction_cache_coin ON extraction_cache(coin)')
  })

  migrate(cache, 'cache', 2, (db) => {
    db.run(`CREATE TABLE IF NOT EXISTS coin_discoveries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      coin        TEXT NOT NULL,
      score       REAL NOT NULL,
      reasoning   TEXT NOT NULL,
      market_data TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','auto_added')),
      cycle_id    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_discoveries_created ON coin_discoveries(created_at DESC)')
    db.run('CREATE INDEX IF NOT EXISTS idx_discoveries_status ON coin_discoveries(status)')
  })

  migrate(cache, 'cache', 3, (db) => {
    try { db.run("ALTER TABLE llm_calls ADD COLUMN base_url TEXT NOT NULL DEFAULT ''") } catch { /* already exists in fresh schema */ }
  })

  // ── Trading DB ────────────────────────────────────────────────────────────

  migrate(trading, 'trading', 1, (db) => {
    try { db.run('ALTER TABLE trades ADD COLUMN fee_cost REAL NOT NULL DEFAULT 0') } catch { /* already exists in fresh schema */ }
    try { db.run("ALTER TABLE trades ADD COLUMN fee_currency TEXT NOT NULL DEFAULT 'USDC'") } catch { /* already exists in fresh schema */ }
  })

  migrate(trading, 'trading', 2, (db) => {
    // portfolio_entries: expand source CHECK constraint to include 'transfer'
    const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='portfolio_entries'")
    const sql = rows[0]?.values?.[0]?.[0] as string | undefined
    if (sql && !sql.includes("'transfer'")) {
      db.run('ALTER TABLE portfolio_entries RENAME TO portfolio_entries_old')
      db.run(`CREATE TABLE portfolio_entries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        coin        TEXT NOT NULL,
        quantity    REAL NOT NULL,
        buy_price   REAL NOT NULL,
        buy_date    TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
        source      TEXT NOT NULL DEFAULT 'trade' CHECK(source IN ('trade','manual','transfer')),
        trade_id    INTEGER REFERENCES trades(id),
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`)
      db.run('INSERT INTO portfolio_entries SELECT * FROM portfolio_entries_old')
      db.run('DROP TABLE portfolio_entries_old')
      db.run('CREATE INDEX IF NOT EXISTS idx_portfolio_entries_status ON portfolio_entries(status)')
    }
  })

  migrate(trading, 'trading', 3, (db) => {
    db.run(`CREATE TABLE IF NOT EXISTS sl_tp_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      coin        TEXT NOT NULL,
      stop_loss   REAL NOT NULL,
      take_profit REAL,
      event       TEXT NOT NULL DEFAULT 'update' CHECK(event IN ('open','update','close')),
      price       REAL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_sl_tp_history_coin ON sl_tp_history(coin, created_at)')
  })

  migrate(trading, 'trading', 4, (db) => {
    db.run(`CREATE TABLE IF NOT EXISTS position_adjustments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id     INTEGER NOT NULL,
      coin            TEXT NOT NULL,
      old_stop_loss   REAL,
      old_take_profit REAL,
      new_stop_loss   REAL,
      new_take_profit REAL,
      reasoning       TEXT,
      confidence      REAL,
      status          TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPLIED','REJECTED','EXPIRED')),
      cycle_id        TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_position_adjustments_status ON position_adjustments(status)')
    db.run('CREATE INDEX IF NOT EXISTS idx_position_adjustments_coin ON position_adjustments(coin, created_at)')
  })

  migrate(trading, 'trading', 5, (db) => {
    // position_reviews: add ADJUST action + new SL/TP columns (rebuild to widen CHECK)
    const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='position_reviews'")
    const sql = rows[0]?.values?.[0]?.[0] as string | undefined
    if (sql && !sql.includes("'ADJUST'")) {
      db.run('ALTER TABLE position_reviews RENAME TO position_reviews_old')
      db.run(`CREATE TABLE position_reviews (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        coin            TEXT NOT NULL,
        action          TEXT NOT NULL CHECK(action IN ('HOLD','CLOSE','REDUCE','ADJUST')),
        confidence      REAL NOT NULL,
        reasoning       TEXT NOT NULL,
        reduce_to_pct   INTEGER,
        new_stop_loss   REAL,
        new_take_profit REAL,
        market_data     TEXT NOT NULL DEFAULT '{}',
        cycle_id        TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`)
      db.run(`INSERT INTO position_reviews
        (id, coin, action, confidence, reasoning, reduce_to_pct, market_data, cycle_id, created_at)
        SELECT id, coin, action, confidence, reasoning, reduce_to_pct, market_data, cycle_id, created_at
        FROM position_reviews_old`)
      db.run('DROP TABLE position_reviews_old')
      db.run('CREATE INDEX IF NOT EXISTS idx_position_reviews_created ON position_reviews(created_at DESC)')
      db.run('CREATE INDEX IF NOT EXISTS idx_position_reviews_coin ON position_reviews(coin)')
    }
  })

  migrate(trading, 'trading', 6, (db) => {
    // positions: add exchange-side OCO tracking + horizon columns
    for (const [col, def] of [
      ['oco_order_list_id', 'TEXT'],
      ['oco_sl_order_id', 'TEXT'],
      ['oco_tp_order_id', 'TEXT'],
      ['oco_status', "TEXT NOT NULL DEFAULT 'NONE'"],
      ['oco_synced_at', 'TEXT'],
      ['horizon', "TEXT NOT NULL DEFAULT 'medium'"],
    ]) {
      try {
        db.run(`ALTER TABLE positions ADD COLUMN ${col} ${def}`)
      } catch { /* column already exists from a prior partial run */ }
    }
  })

  // ── Settings seeds (idempotent — INSERT OR IGNORE) ────────────────────────
  const seeds = [
    ['default_horizon', 'auto'],
    ['discover_cron', '0 6 * * *'],
    ['discover_min_score', '0.65'],
    ['discover_top_n', '30'],
    ['discover_auto_add', 'false'],
    ['discover_min_volume_usd', '5000000'],
    ['monitor_auto_run', 'false'],
    ['monitor_cron', '0 */4 * * *'],
    ['monitor_adjust_sltp', 'true'],
    ['monitor_auto_approve', 'false'],
    ['monitor_sl_pct_short', '3'],
    ['monitor_sl_pct_medium', '5'],
    ['monitor_sl_pct_long', '10'],
    ['monitor_tp_pct_short', '6'],
    ['monitor_tp_pct_medium', '10'],
    ['monitor_tp_pct_long', '20'],
    ['oco_sl_buffer_pct', '0.5'],
  ]
  for (const [key, value] of seeds) {
    settings.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value])
  }
}
