import Database from 'better-sqlite3'
import { SCHEMA } from './schema.js'
import { logger } from '../core/logger.js'
import { BotSettings } from '../types.js'

const DB_PATH = process.env.DB_PATH || './data/cryptobot.db'

let db: Database.Database

export function initDB(): Database.Database {
  logger.info('Initializing database', { path: DB_PATH })
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  logger.info('Database initialized')
  return db
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDB() first.')
  return db
}

export function getSettings(): BotSettings {
  const rows = getDB().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  return {
    watchlist: JSON.parse(map.watchlist || '[]'),
    interval_minutes: parseInt(map.interval_minutes || '60', 10),
    min_confidence: parseFloat(map.min_confidence || '0.3'),
    max_position_size_usd: parseFloat(map.max_position_size_usd || '100'),
    approval_required: map.approval_required === 'true',
  }
}

export function updateSetting(key: string, value: string): void {
  getDB().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}