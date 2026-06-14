/**
 * One-off data migration: SQLite (sql.js .db files) → MongoDB.
 *
 * Usage (from backend/):
 *   npx tsx scripts/migrate-sqlite-to-mongo.ts                # trading + settings
 *   npx tsx scripts/migrate-sqlite-to-mongo.ts --all          # include caches too
 *   npx tsx scripts/migrate-sqlite-to-mongo.ts --reset        # wipe target collections first
 *
 * Env:
 *   MONGO_URL  (default mongodb://localhost:27017/?directConnection=true)
 *   MONGO_DB   (default cryptobot)
 *   DB_DIR     (default ../data — where the .db files live)
 *
 * It preserves the integer primary keys exactly (stored as both _id and id) so
 * every cross-row reference (signal_id, entry_id, position_id, conversation_id…)
 * stays valid, and seeds the counters collection so new inserts won't collide.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import initSqlJs from 'sql.js'
import { connectMongo, getDb, closeMongo } from '../src/db/client.js'
import { ensureIndexes } from '../src/db/indexes.js'
import { seedCounter } from '../src/db/counters.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DB_DIR || path.join(__dirname, '..', '..', 'data')

const args = new Set(process.argv.slice(2))
const INCLUDE_CACHES = args.has('--all')
const RESET = args.has('--reset')

// Which .db files to read. The durable state lives in trading.db + settings.db;
// pipeline.db / cache.db are regenerable and skipped unless --all.
const SOURCE_FILES = ['settings.db', 'trading.db', ...(INCLUDE_CACHES ? ['pipeline.db', 'cache.db'] : [])]

// Collections keyed by a natural (string) primary key rather than an integer id.
// For these we map the source key column straight onto Mongo's _id.
const NATURAL_KEY: Record<string, string> = {
  settings: 'key',
  monitor_notes: 'coin',
  entry_intents: 'id',
  entry_events: 'id',
  extraction_cache: 'url',
  ohlcv_cache: 'cache_key',
}

// SQLite bookkeeping tables we never migrate.
const SKIP_TABLES = new Set(['schema_version', 'sqlite_sequence'])

type SqlRow = Record<string, unknown>

function readTable(db: import('sql.js').Database, table: string): SqlRow[] {
  const res = db.exec(`SELECT * FROM ${table}`)
  if (!res[0]) return []
  const { columns, values } = res[0]
  return values.map(row => {
    const obj: SqlRow = {}
    columns.forEach((c, i) => { obj[c] = row[i] })
    return obj
  })
}

function listTables(db: import('sql.js').Database): string[] {
  const res = db.exec("SELECT name FROM sqlite_master WHERE type='table'")
  if (!res[0]) return []
  return res[0].values.map(r => String(r[0])).filter(t => !SKIP_TABLES.has(t))
}

async function main(): Promise<void> {
  const SQL = await initSqlJs()
  await connectMongo()
  await ensureIndexes()

  let totalDocs = 0

  for (const file of SOURCE_FILES) {
    const filePath = path.join(DATA_DIR, file)
    if (!fs.existsSync(filePath)) {
      console.warn(`! skip ${file} (not found at ${filePath})`)
      continue
    }
    const buf = fs.readFileSync(filePath)
    if (buf.length === 0) { console.warn(`! skip ${file} (empty)`); continue }

    const db = new SQL.Database(buf)
    console.log(`\n=== ${file} ===`)

    for (const table of listTables(db)) {
      const rows = readTable(db, table)
      const coll = getDb().collection(table)

      if (RESET) await coll.deleteMany({})
      else if (await coll.countDocuments() > 0) {
        console.warn(`  - ${table}: target not empty, skipping (use --reset to overwrite)`)
        continue
      }

      if (rows.length === 0) { console.log(`  - ${table}: 0 rows`); continue }

      const naturalKey = NATURAL_KEY[table]
      let maxId = 0
      const docs = rows.map(r => {
        const doc: SqlRow = { ...r }
        if (naturalKey) {
          doc._id = r[naturalKey]
        } else if (r.id !== undefined && r.id !== null) {
          // Integer-PK table: id becomes _id (and stays as id for call-site reads).
          doc._id = r.id
          const n = Number(r.id)
          if (Number.isFinite(n) && n > maxId) maxId = n
        }
        return doc
      })

      await coll.insertMany(docs, { ordered: false })
      if (!naturalKey && maxId > 0) await seedCounter(table, maxId)
      totalDocs += docs.length
      console.log(`  - ${table}: ${docs.length} docs${maxId ? ` (counter → ${maxId})` : ''}`)
    }

    db.close()
  }

  console.log(`\n✓ Migration complete — ${totalDocs} documents imported into "${process.env.MONGO_DB || 'cryptobot'}".`)
  await closeMongo()
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
