import fs from 'fs'
import path from 'path'
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import { SCHEMAS } from './schema.js'
import { runMigrations } from './migrations.js'
import { logger } from '../core/logger.js'

const DATA_DIR = process.env.DB_DIR || './data'

const DB_FILES: Record<string, string> = {
  settings: path.join(DATA_DIR, 'settings.db'),
  trading:  path.join(DATA_DIR, 'trading.db'),
  pipeline: path.join(DATA_DIR, 'pipeline.db'),
  cache:    path.join(DATA_DIR, 'cache.db'),
}

const DBS: Record<string, SqlJsDatabase> = {}

// Table → db name registry (populated at init from SCHEMAS)
const TABLE_DB: Record<string, string> = {}

let savePending = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 2000

function loadOrCreate(SQL: initSqlJs.SqlJsStatic, filePath: string): SqlJsDatabase {
  if (fs.existsSync(filePath)) {
    return new SQL.Database(fs.readFileSync(filePath))
  }
  return new SQL.Database()
}

function buildTableRegistry(): void {
  const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi
  for (const [dbName, sql] of Object.entries(SCHEMAS)) {
    let match: RegExpExecArray | null
    while ((match = tablePattern.exec(sql)) !== null) {
      TABLE_DB[match[1].toLowerCase()] = dbName
    }
    tablePattern.lastIndex = 0
  }
}

export async function initDB(): Promise<void> {
  logger.info('Initializing databases', { dir: DATA_DIR })

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

  const SQL = await initSqlJs()

  buildTableRegistry()

  for (const [name, filePath] of Object.entries(DB_FILES)) {
    DBS[name] = loadOrCreate(SQL, filePath)
    DBS[name].run(SCHEMAS[name])
  }

  runMigrations(DBS)
  saveAll()

  logger.info('Databases initialized', { dbs: Object.keys(DB_FILES) })
}

export function getDB(name: string = 'trading'): SqlJsDatabase {
  const db = DBS[name]
  if (!db) throw new Error(`DB "${name}" not initialized. Call initDB() first.`)
  return db
}

export function getTableDB(table: string): SqlJsDatabase {
  const name = TABLE_DB[table.toLowerCase()] ?? 'trading'
  return getDB(name)
}

export function saveAll(): void {
  for (const [name, filePath] of Object.entries(DB_FILES)) {
    const db = DBS[name]
    if (!db) continue
    fs.writeFileSync(filePath, Buffer.from(db.export()))
  }
}

// Keep saveDB as an alias for backwards-compat (saves all)
export const saveDB = saveAll

export function scheduleSave(): void {
  if (savePending) return
  savePending = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveAll()
    savePending = false
  }, SAVE_DEBOUNCE_MS)
}
