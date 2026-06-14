#!/usr/bin/env node
// Agent DB tool — inspect and (carefully) mutate the bot's SQLite databases.
//
// The app keeps four sql.js databases (settings/trading/pipeline/cache) loaded
// IN MEMORY and persists them to data/*.db. Two consequences drive this tool:
//   1. Reads are safe any time — we open the on-disk file read-only.
//   2. Writes are NOT: a running bot would overwrite the file from its in-memory
//      copy. So writes stop the backend, back up the file, mutate it inside the
//      backend container (the files are root-owned), then restart the backend.
//
// Dual-mode: run locally (orchestrates docker) for everything; the `_exec-raw`
// subcommand is the in-container half of a write and is not meant to be called
// by hand. See tools/README.md and AGENTS.md.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const TOOLS_DIR = __dirname

const IN_CONTAINER = !!process.env.CRYPTOBOT_IN_CONTAINER
const BACKEND_DIR = IN_CONTAINER ? '/app' : path.join(REPO, 'backend')
const DATA_DIR = process.env.CRYPTOBOT_DATA_DIR || (IN_CONTAINER ? '/app/data' : path.join(REPO, 'data'))
const DB_NAMES = ['settings', 'trading', 'pipeline', 'cache']

const require = createRequire(path.join(BACKEND_DIR, 'package.json'))
let _SQL
async function sqljs() { return _SQL ??= await (require('sql.js'))() }

const dbFile = (name) => path.join(DATA_DIR, `${name}.db`)

/* --------------------------------- helpers --------------------------------- */

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else { flags[key] = next; i++ }
    } else positional.push(a)
  }
  return { flags, positional }
}

async function openRead(name) {
  const SQL = await sqljs()
  if (!fs.existsSync(dbFile(name))) throw new Error(`db file not found: ${dbFile(name)}`)
  return new SQL.Database(fs.readFileSync(dbFile(name)))
}

async function listTables(name) {
  const db = await openRead(name)
  try {
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    return r.length ? r[0].values.flat() : []
  } finally { db.close() }
}

// Which db file owns a given table (the schema namespaces them, one table per db).
async function whichDb(table) {
  for (const name of DB_NAMES) {
    if ((await listTables(name)).map(t => t.toLowerCase()).includes(table.toLowerCase())) return name
  }
  return null
}

// Cap cell width in table output so a wide JSON/TEXT column (e.g.
// pipeline_events.data) can't flood the terminal. Use --json for full values.
const MAX_CELL = 200
const cell = v => {
  const s = fmt(v)
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s
}

function printResult(result, json) {
  if (json) { console.log(JSON.stringify(toObjects(result), null, 2)); return }
  if (!result.length) { console.log('(no rows)'); return }
  const { columns, values } = result[0]
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...values.map(r => cell(r[i]).length)))
  const line = cells => cells.map((c, i) => cell(c).padEnd(widths[i])).join('  ')
  console.log(line(columns))
  console.log(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of values) console.log(line(row))
  console.log(`\n(${values.length} row${values.length === 1 ? '' : 's'})`)
}

function toObjects(result) {
  if (!result.length) return []
  const { columns, values } = result[0]
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
}

const fmt = v => v === null || v === undefined ? 'NULL' : String(v)

const isReadOnly = sql =>
  /^\s*\(*\s*(select|with|pragma|explain)\b/i.test(sql)

function docker(args, { stream = false } = {}) {
  return execFileSync('docker', ['compose', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: stream ? 'inherit' : ['ignore', 'pipe', 'inherit'],
  })
}

function backendRunning() {
  const id = docker(['ps', '-q', 'backend']).trim()
  if (!id) return false
  return execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', id], { encoding: 'utf8' }).trim() === 'true'
}

/* -------------------------------- commands --------------------------------- */

async function cmdTables() {
  for (const name of DB_NAMES) {
    const tables = await listTables(name)
    console.log(`${name}: ${tables.length ? tables.join(', ') : '(none)'}`)
  }
}

async function cmdSchema(table, flags) {
  const name = flags.db || await whichDb(table)
  if (!name) throw new Error(`table not found in any db: ${table}`)
  const db = await openRead(name)
  try {
    const r = db.exec("SELECT sql FROM sqlite_master WHERE name = ?", [table])
    if (!r.length) throw new Error(`no such table: ${table}`)
    console.log(`-- db: ${name}\n${r[0].values[0][0]};`)
  } finally { db.close() }
}

async function cmdFind(table) {
  const name = await whichDb(table)
  console.log(name ? `${table} -> ${name}.db` : `not found: ${table}`)
}

async function cmdQuery(sql, flags) {
  if (!sql) throw new Error('usage: query "<SELECT ...>" [--db <name>] [--json]')
  if (!isReadOnly(sql)) throw new Error('`query` allows only SELECT/WITH/PRAGMA/EXPLAIN — use `exec` for writes')
  const candidates = flags.db ? [flags.db] : DB_NAMES
  const notFound = []
  for (const name of candidates) {
    const db = await openRead(name)
    try {
      const r = db.exec(sql)
      printResult(r, !!flags.json)
      return
    } catch (e) {
      // "no such table" just means this db isn't the right one — keep routing.
      // Any OTHER error (bad column, syntax) means this db recognised the query's
      // table, so it's the real error — surface it now instead of masking it
      // behind a later db's "no such table".
      if (/no such table/i.test(e.message)) { notFound.push(name); continue }
      throw new Error(`query error in ${name}.db: ${e.message}`)
    } finally { db.close() }
  }
  throw new Error(
    `no matching table in ${notFound.join('/')} — verify the name with ` +
    '`tables` / `find <table>`' + (flags.db ? '' : ', or pass --db <name>'))
}

// Local orchestration of a write: stop bot -> backup -> mutate in container -> restart.
async function cmdExec(sql, flags) {
  if (IN_CONTAINER) throw new Error('refusing to orchestrate inside container; use _exec-raw')
  if (!sql) throw new Error('usage: exec "<SQL>" --db <name> --yes')
  if (isReadOnly(sql)) throw new Error('that looks like a read — use `query` instead')
  const name = flags.db
  if (!name || !DB_NAMES.includes(name)) throw new Error(`--db <${DB_NAMES.join('|')}> is required for exec`)
  if (!flags.yes) throw new Error('writes are destructive — re-run with --yes to confirm')

  const wasRunning = backendRunning()
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  console.error(`[exec] target=${name}.db  backendRunning=${wasRunning}`)

  if (wasRunning) { console.error('[exec] stopping backend...'); docker(['stop', 'backend'], { stream: true }) }
  try {
    console.error(`[exec] backing up ${name}.db -> ${name}.db.bak-${ts}`)
    docker(['run', '--rm', '--no-deps', 'backend',
      'cp', `/app/data/${name}.db`, `/app/data/${name}.db.bak-${ts}`])

    console.error('[exec] applying write in container...')
    docker(['run', '--rm', '--no-deps',
      '-e', 'CRYPTOBOT_IN_CONTAINER=1',
      '-v', `${TOOLS_DIR}:/app/tools`,
      'backend', 'node', '/app/tools/db.mjs', '_exec-raw', '--db', name, '--sql', sql], { stream: true })
  } finally {
    if (wasRunning) { console.error('[exec] restarting backend...'); docker(['start', 'backend'], { stream: true }) }
  }
  console.error(`[exec] done. backup: data/${name}.db.bak-${ts}`)
}

// In-container half of a write — mutates the on-disk file directly. Internal.
async function cmdExecRaw(flags) {
  if (!IN_CONTAINER) throw new Error('_exec-raw must run inside the container (CRYPTOBOT_IN_CONTAINER=1)')
  const name = flags.db
  const sql = flags.sql
  if (!DB_NAMES.includes(name) || !sql) throw new Error('_exec-raw needs --db and --sql')
  const SQL = await sqljs()
  const db = new SQL.Database(fs.readFileSync(dbFile(name)))
  try {
    db.run(sql)
    const changes = db.getRowsModified()
    fs.writeFileSync(dbFile(name), Buffer.from(db.export()))
    console.log(`rows modified: ${changes}`)
  } finally { db.close() }
}

// Canned read views over commonly-needed tables.
const VIEWS = {
  trades:    n => `SELECT id,coin,side,quantity,price,total,status,created_at FROM trades ORDER BY id DESC LIMIT ${n ?? 20}`,
  positions: () => `SELECT id,coin,side,quantity,entry_price,current_sl,take_profit,oco_status,status,pnl FROM positions WHERE status='OPEN' ORDER BY id DESC`,
  portfolio: () => `SELECT id,coin,quantity,buy_price,status,source FROM portfolio_entries WHERE status='OPEN' ORDER BY coin`,
  settings:  () => `SELECT key,value FROM settings ORDER BY key`,
  intents:   () => `SELECT coin,signal_price,target_price,notional_usdc,atr,expires_at FROM entry_intents ORDER BY coin`,
  llm:       n => `SELECT id,module,model,status,duration_ms,created_at FROM llm_calls ORDER BY id DESC LIMIT ${n ?? 20}`,
}

async function cmdView(view, arg, flags) {
  const table = { trades: 'trades', positions: 'positions', portfolio: 'portfolio_entries',
    settings: 'settings', intents: 'entry_intents', llm: 'llm_calls' }[view]
  const name = await whichDb(table)
  if (!name) throw new Error(`table for view '${view}' not found`)
  const n = arg && /^\d+$/.test(arg) ? Number(arg) : undefined
  const db = await openRead(name)
  try { printResult(db.exec(VIEWS[view](n)), !!flags.json) }
  finally { db.close() }
}

const HELP = `Agent DB tool — inspect & manage the bot's SQLite databases.

Usage: node tools/db.mjs <command> [args] [--flags]

Read (run any time, local & read-only):
  tables                       List tables across all four db files
  find <table>                 Report which db file holds a table
  schema <table> [--db N]      Print CREATE statement for a table
  query "<SELECT ...>" [--db N] [--json]
                               Run a read-only query (auto-routes across dbs)
  trades [N] [--json]          Recent trades (default 20)
  positions [--json]           Open positions
  portfolio [--json]           Open portfolio (ledger) entries
  settings [--json]            All settings key/values
  intents [--json]             Active entry-timing intents
  llm [N] [--json]             Recent LLM calls

Write (stops backend, backs up the db, mutates in-container, restarts):
  exec "<SQL>" --db <name> --yes
                               INSERT/UPDATE/DELETE/DDL on one db. --db & --yes required.

Databases: ${DB_NAMES.join(', ')}   (data dir: ${DATA_DIR})
`

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { flags, positional } = parseArgs(rest)
  switch (cmd) {
    case undefined:
    case 'help': case '--help': case '-h': console.log(HELP); break
    case 'tables': await cmdTables(); break
    case 'find': await cmdFind(positional[0]); break
    case 'schema': await cmdSchema(positional[0], flags); break
    case 'query': await cmdQuery(positional[0], flags); break
    case 'exec': await cmdExec(positional[0], flags); break
    case '_exec-raw': await cmdExecRaw(flags); break
    case 'trades': case 'positions': case 'portfolio':
    case 'settings': case 'intents': case 'llm':
      await cmdView(cmd, positional[0], flags); break
    default:
      console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exit(2)
  }
}

main().catch(err => { console.error(`error: ${err.message}`); process.exit(1) })
