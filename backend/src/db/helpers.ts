import { Database as SqlJsDatabase } from 'sql.js'
import {
  getDB, getTableDB, getTableDBName,
  scheduleSave, saveOne,
  isInTransaction, setTransactionState,
} from './connection.js'

// Tables that must be persisted synchronously to avoid data loss on crash.
const CRITICAL_TABLES = new Set(['trades', 'positions', 'portfolio_entries', 'portfolio_snapshots'])

// Extract the first real table name from a SQL statement for DB routing.
function resolveDb(sql: string): SqlJsDatabase {
  const match = sql.match(
    /(?:FROM|UPDATE|INTO|JOIN|TABLE)\s+(\w+)/i
  )
  return match ? getTableDB(match[1]) : getTableDB('trades')
}

function resolveTableName(sql: string): string {
  const match = sql.match(/(?:FROM|UPDATE|INTO|JOIN|TABLE)\s+(\w+)/i)
  return match?.[1]?.toLowerCase() ?? ''
}

/**
 * Run all synchronous DB writes inside fn() as a single atomic SQLite transaction
 * on the trading database. Commits on success and immediately persists to disk.
 * Rolls back on any exception and re-throws.
 *
 * NOTE: fn() must be synchronous. Async operations (exchange API, broadcasts)
 * must happen before or after this call.
 */
export function withTransaction<T>(fn: () => T): T {
  const db = getDB('trading')
  setTransactionState(true)
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    setTransactionState(false)
    saveOne('trading')
    return result
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    setTransactionState(false)
    throw err
  }
}

export function queryAll(sql: string, params?: (number | string | null)[]): Record<string, unknown>[] {
  const db = resolveDb(sql)
  if (params) {
    const stmt = db.prepare(sql)
    try {
      stmt.bind(params as any)
      const rows: Record<string, unknown>[] = []
      while (stmt.step()) rows.push(stmt.getAsObject())
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
  return queryAll(sql, params)[0] || null
}

export function runSQL(sql: string, params?: (number | string | null)[]): { changes: number; lastInsertRowid: number } {
  const db = resolveDb(sql)
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

  const tableName = resolveTableName(sql)
  if (!isInTransaction() && CRITICAL_TABLES.has(tableName)) {
    // Sync-persist critical tables immediately — don't wait for the debounce.
    saveOne(getTableDBName(tableName))
  } else {
    scheduleSave()
  }

  const result = db.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')
  const row = result[0]?.values?.[0]
  return { changes: (row?.[0] as number) || 0, lastInsertRowid: (row?.[1] as number) || 0 }
}
