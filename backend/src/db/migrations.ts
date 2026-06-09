import { Database as SqlJsDatabase } from 'sql.js'
import { logger } from '../core/logger.js'

export function runMigrations(dbs: Record<string, SqlJsDatabase>): void {
  const trading  = dbs['trading']
  const cache    = dbs['cache']
  const settings = dbs['settings']

  // extraction_cache: add coin column
  try {
    cache.run("ALTER TABLE extraction_cache ADD COLUMN coin TEXT NOT NULL DEFAULT ''")
    logger.info('Migrated extraction_cache: added coin column')
  } catch { /* already exists */ }
  try {
    cache.run('CREATE INDEX IF NOT EXISTS idx_extraction_cache_coin ON extraction_cache(coin)')
  } catch { /* already exists */ }

  // trades: add fee columns
  try {
    trading.run('ALTER TABLE trades ADD COLUMN fee_cost REAL NOT NULL DEFAULT 0')
    logger.info('Migrated trades: added fee_cost column')
  } catch { /* already exists */ }
  try {
    trading.run("ALTER TABLE trades ADD COLUMN fee_currency TEXT NOT NULL DEFAULT 'USDC'")
    logger.info('Migrated trades: added fee_currency column')
  } catch { /* already exists */ }

  // portfolio_entries: expand source CHECK constraint to include 'transfer'
  try {
    const rows = trading.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='portfolio_entries'")
    const sql = rows[0]?.values?.[0]?.[0] as string | undefined
    if (sql && !sql.includes("'transfer'")) {
      trading.run('ALTER TABLE portfolio_entries RENAME TO portfolio_entries_old')
      trading.run(`CREATE TABLE portfolio_entries (
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
      trading.run('INSERT INTO portfolio_entries SELECT * FROM portfolio_entries_old')
      trading.run('DROP TABLE portfolio_entries_old')
      trading.run('CREATE INDEX IF NOT EXISTS idx_portfolio_entries_status ON portfolio_entries(status)')
      logger.info('Migrated portfolio_entries: expanded source CHECK constraint')
    }
  } catch (err) {
    logger.warn('portfolio_entries source constraint migration failed', { err: String(err) })
  }

  // coin_discoveries table for existing DBs
  try {
    cache.run(`CREATE TABLE IF NOT EXISTS coin_discoveries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      coin        TEXT NOT NULL,
      score       REAL NOT NULL,
      reasoning   TEXT NOT NULL,
      market_data TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','auto_added')),
      cycle_id    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    cache.run('CREATE INDEX IF NOT EXISTS idx_discoveries_created ON coin_discoveries(created_at DESC)')
    cache.run('CREATE INDEX IF NOT EXISTS idx_discoveries_status ON coin_discoveries(status)')
  } catch { /* already exists */ }

  // llm_calls: add base_url column
  try {
    cache.run("ALTER TABLE llm_calls ADD COLUMN base_url TEXT NOT NULL DEFAULT ''")
    logger.info('Migrated llm_calls: added base_url column')
  } catch { /* already exists */ }

  // sl_tp_history table for existing DBs
  try {
    trading.run(`CREATE TABLE IF NOT EXISTS sl_tp_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      coin        TEXT NOT NULL,
      stop_loss   REAL NOT NULL,
      take_profit REAL,
      event       TEXT NOT NULL DEFAULT 'update' CHECK(event IN ('open','update','close')),
      price       REAL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    trading.run('CREATE INDEX IF NOT EXISTS idx_sl_tp_history_coin ON sl_tp_history(coin, created_at)')
  } catch { /* already exists */ }

  // position_adjustments table for existing DBs
  try {
    trading.run(`CREATE TABLE IF NOT EXISTS position_adjustments (
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
    trading.run('CREATE INDEX IF NOT EXISTS idx_position_adjustments_status ON position_adjustments(status)')
    trading.run('CREATE INDEX IF NOT EXISTS idx_position_adjustments_coin ON position_adjustments(coin, created_at)')
  } catch { /* already exists */ }

  // position_reviews: add ADJUST action + new SL/TP columns (rebuild to widen CHECK)
  try {
    const rows = trading.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='position_reviews'")
    const sql = rows[0]?.values?.[0]?.[0] as string | undefined
    if (sql && !sql.includes("'ADJUST'")) {
      trading.run('ALTER TABLE position_reviews RENAME TO position_reviews_old')
      trading.run(`CREATE TABLE position_reviews (
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
      trading.run(`INSERT INTO position_reviews
        (id, coin, action, confidence, reasoning, reduce_to_pct, market_data, cycle_id, created_at)
        SELECT id, coin, action, confidence, reasoning, reduce_to_pct, market_data, cycle_id, created_at
        FROM position_reviews_old`)
      trading.run('DROP TABLE position_reviews_old')
      trading.run('CREATE INDEX IF NOT EXISTS idx_position_reviews_created ON position_reviews(created_at DESC)')
      trading.run('CREATE INDEX IF NOT EXISTS idx_position_reviews_coin ON position_reviews(coin)')
      logger.info('Migrated position_reviews: added ADJUST action + SL/TP columns')
    }
  } catch (err) {
    logger.warn('position_reviews ADJUST migration failed', { err: String(err) })
  }

  // positions: add exchange-side OCO tracking columns
  for (const [col, def] of [
    ['oco_order_list_id', 'TEXT'],
    ['oco_sl_order_id', 'TEXT'],
    ['oco_tp_order_id', 'TEXT'],
    ['oco_status', "TEXT NOT NULL DEFAULT 'NONE'"],
    ['oco_synced_at', 'TEXT'],
    ['horizon', "TEXT NOT NULL DEFAULT 'medium'"],
  ]) {
    try {
      trading.run(`ALTER TABLE positions ADD COLUMN ${col} ${def}`)
      logger.info('Migrated positions: added column', { col })
    } catch { /* already exists */ }
  }

  // Seed settings for existing DBs
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
