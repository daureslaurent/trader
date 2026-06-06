import fs from 'fs'
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import { SCHEMA } from './schema.js'
import { logger } from '../core/logger.js'
import { BotSettings } from '../types.js'
import { config } from '../config/index.js'

const DB_PATH = process.env.DB_PATH || './data/cryptobot.db'

let db: SqlJsDatabase
let savePending = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 2000

export async function initDB(): Promise<SqlJsDatabase> {
  logger.info('Initializing database', { path: DB_PATH })

  const SQL = await initSqlJs()

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
  } else {
    db = new SQL.Database()
  }

  db.run(SCHEMA)

  // Migrate extraction_cache: add coin column if missing (existing DBs won't have it)
  try {
    db.run("ALTER TABLE extraction_cache ADD COLUMN coin TEXT NOT NULL DEFAULT ''")
    logger.info('Migrated extraction_cache: added coin column')
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run('CREATE INDEX IF NOT EXISTS idx_extraction_cache_coin ON extraction_cache(coin)')
  } catch {
    // Index already exists — ignore
  }

  // Migrate trades: add fee columns if missing
  try {
    db.run('ALTER TABLE trades ADD COLUMN fee_cost REAL NOT NULL DEFAULT 0')
    logger.info('Migrated trades: added fee_cost column')
  } catch { /* already exists */ }
  try {
    db.run("ALTER TABLE trades ADD COLUMN fee_currency TEXT NOT NULL DEFAULT 'USDC'")
    logger.info('Migrated trades: added fee_currency column')
  } catch { /* already exists */ }

  // Migrate portfolio_entries: expand source CHECK constraint to include 'transfer'
  try {
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
      logger.info('Migrated portfolio_entries: expanded source CHECK constraint')
    }
  } catch (err) {
    logger.warn('portfolio_entries source constraint migration failed', { err: String(err) })
  }

  // Seed fee_rate setting for existing DBs
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('fee_rate', '0.001')")

  // Seed discover settings for existing DBs
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('discover_cron', '0 6 * * *')")
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('discover_min_score', '0.65')")
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('discover_top_n', '30')")
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('discover_auto_add', 'false')")
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('discover_min_volume_usd', '5000000')")

  // Create coin_discoveries table for existing DBs
  try {
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
  } catch {
    // Already exists — ignore
  }

  saveDB()
  logger.info('Database initialized')
  return db
}

export function saveDB(): void {
  const dir = DB_PATH.substring(0, DB_PATH.lastIndexOf('/'))
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const data = db.export()
  fs.writeFileSync(DB_PATH, Buffer.from(data))
}

export function scheduleSave(): void {
  if (savePending) return
  savePending = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveDB()
    savePending = false
  }, SAVE_DEBOUNCE_MS)
}

export function getDB(): SqlJsDatabase {
  if (!db) throw new Error('Database not initialized. Call initDB() first.')
  return db
}

export function queryAll(sql: string, params?: (number | string | null)[]): Record<string, unknown>[] {
  if (params) {
    const stmt = db.prepare(sql)
    try {
      stmt.bind(params as any)
      const rows: Record<string, unknown>[] = []
      while (stmt.step()) {
        rows.push(stmt.getAsObject())
      }
      return rows
    } finally {
      stmt.free()
    }
  }
  const result = db.exec(sql)
  if (!result[0]) return []
  const { columns, values } = result[0]
  return values.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {}
    columns.forEach((col: string, i: number) => { obj[col] = row[i] })
    return obj
  })
}

export function queryOne(sql: string, params?: (number | string | null)[]): Record<string, unknown> | null {
  const rows = queryAll(sql, params)
  return rows[0] || null
}

export function runSQL(sql: string, params?: (number | string | null)[]): { changes: number; lastInsertRowid: number } {
  if (params) {
    const stmt = db.prepare(sql)
    try {
      stmt.bind(params as any)
      stmt.step()
    } finally {
      stmt.free()
    }
  } else {
    db.run(sql)
  }
  scheduleSave()
  const result = db.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')
  const row = result[0]?.values?.[0]
  return { changes: (row?.[0] as number) || 0, lastInsertRowid: (row?.[1] as number) || 0 }
}

export function getSettings(): BotSettings {
  const rows = queryAll('SELECT key, value FROM settings')
  const map: Record<string, string> = {}
  for (const row of rows) map[row.key as string] = row.value as string
  return {
    watchlist: JSON.parse(map.watchlist || '[]'),
    pipeline_cron: map.pipeline_cron || '0 * * * *',
    min_confidence: parseFloat(map.min_confidence || '0.3'),
    max_position_size_usd: parseFloat(map.max_position_size_usd || '100'),
    approval_required: map.approval_required === 'true',
    stop_loss_atr: parseFloat(map.stop_loss_atr || '1.5'),
    take_profit_atr: parseFloat(map.take_profit_atr || '3.0'),
    max_risk_per_trade: parseFloat(map.max_risk_per_trade || '0.02'),
    max_open_positions: parseInt(map.max_open_positions || '5', 10),
    cache_ttl_hours: parseInt(map.cache_ttl_hours || '13', 10),
    fee_rate: parseFloat(map.fee_rate || '0.001'),
    discover_cron: map.discover_cron || '0 6 * * *',
    discover_min_score: parseFloat(map.discover_min_score || '0.65'),
    discover_top_n: parseInt(map.discover_top_n || '30', 10),
    discover_auto_add: map.discover_auto_add === 'true',
    discover_min_volume_usd: parseFloat(map.discover_min_volume_usd || '5000000'),
    discoverer_base_url: map.discoverer_base_url || config.discoverer.baseURL,
    discoverer_model: map.discoverer_model || config.discoverer.model,
  }
}

export function updateSetting(key: string, value: string): void {
  runSQL('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
}
