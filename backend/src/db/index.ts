import fs from 'fs'
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import { SCHEMA } from './schema.js'
import { logger } from '../core/logger.js'
import { BotSettings } from '../types.js'

const DB_PATH = process.env.DB_PATH || './data/cryptobot.db'

let db: SqlJsDatabase

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

export function getDB(): SqlJsDatabase {
  if (!db) throw new Error('Database not initialized. Call initDB() first.')
  return db
}

export function queryAll(sql: string, params?: (number | string | null)[]): Record<string, unknown>[] {
  if (params) {
    const stmt = db.prepare(sql)
    stmt.bind(params as any)
    const rows: Record<string, unknown>[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return rows
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
    stmt.bind(params as any)
    stmt.step()
    stmt.free()
  } else {
    db.run(sql)
  }
  saveDB()
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
    interval_minutes: parseInt(map.interval_minutes || '60', 10),
    min_confidence: parseFloat(map.min_confidence || '0.3'),
    max_position_size_usd: parseFloat(map.max_position_size_usd || '100'),
    approval_required: map.approval_required === 'true',
  }
}

export function updateSetting(key: string, value: string): void {
  runSQL('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
}
