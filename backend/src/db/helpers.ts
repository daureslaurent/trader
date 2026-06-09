import { Database as SqlJsDatabase } from 'sql.js'
import { getTableDB, scheduleSave } from './connection.js'

// Extract the first real table name from a SQL statement for DB routing.
function resolveDb(sql: string): SqlJsDatabase {
  const match = sql.match(
    /(?:FROM|UPDATE|INTO|JOIN|TABLE)\s+(\w+)/i
  )
  return match ? getTableDB(match[1]) : getTableDB('trades')
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
  scheduleSave()
  const result = db.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')
  const row = result[0]?.values?.[0]
  return { changes: (row?.[0] as number) || 0, lastInsertRowid: (row?.[1] as number) || 0 }
}
