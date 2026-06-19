#!/usr/bin/env node
// Agent DB tool — inspect and (carefully) mutate the bot's MongoDB data.
//
// The app now stores everything in a single MongoDB database (one collection per
// former table). Unlike the old sql.js setup, Mongo is a real shared datastore:
//   1. Reads are safe any time — the server handles concurrency.
//   2. Writes are safe live too — no need to stop the bot or back up a file; the
//      backend reads from the same server, not an in-memory file copy. A write is
//      still destructive, so `update`/`delete` require --yes.
//
// Connects with MONGO_URL (default mongodb://localhost:27017/?directConnection=true)
// and MONGO_DB (default cryptobot). Borrows the `mongodb` driver from
// backend/node_modules — run after `npm install` in backend/.
// See tools/README.md and AGENTS.md.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const BACKEND_DIR = path.join(REPO, 'backend')

const MONGO_URL = process.env.MONGO_URL || 'mongodb://192.168.1.23:27017/?directConnection=true'
const MONGO_DB = process.env.MONGO_DB || 'cryptobot'

const require = createRequire(path.join(BACKEND_DIR, 'package.json'))
const { MongoClient } = require('mongodb')

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

// Parse a --filter/--sort/--set/--projection JSON flag; '' / true → empty object.
function json(flag, fallback = {}) {
  if (flag === undefined || flag === true) return fallback
  try { return JSON.parse(flag) }
  catch (e) { throw new Error(`invalid JSON: ${flag}\n  ${e.message}`) }
}

// Mongo _id may be an integer (most collections) or a natural string key
// (settings/monitor_notes/entry_*/extraction_cache/ohlcv_cache). Coerce a CLI id.
function coerceId(raw) {
  if (raw === undefined) throw new Error('id required')
  return /^-?\d+$/.test(raw) ? Number(raw) : raw
}

let _client
async function db() {
  if (!_client) { _client = new MongoClient(MONGO_URL); await _client.connect() }
  return _client.db(MONGO_DB)
}
async function close() { if (_client) await _client.close() }

const MAX_CELL = 200
const fmt = v => v === null || v === undefined ? 'NULL'
  : typeof v === 'object' ? JSON.stringify(v) : String(v)
const cell = v => { const s = fmt(v); return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s }

// Print an array of docs as a table (columns inferred or supplied) or as JSON.
function printDocs(docs, { json: asJson, columns } = {}) {
  if (asJson) { console.log(JSON.stringify(docs, null, 2)); return }
  if (!docs.length) { console.log('(no documents)'); return }
  const cols = columns ?? [...docs.reduce((s, d) => { Object.keys(d).forEach(k => s.add(k)); return s }, new Set())]
  const widths = cols.map(c => Math.max(c.length, ...docs.map(d => cell(d[c]).length)))
  const line = cells => cells.map((c, i) => cell(c).padEnd(widths[i])).join('  ')
  console.log(line(cols))
  console.log(widths.map(w => '-'.repeat(w)).join('  '))
  for (const d of docs) console.log(line(cols.map(c => d[c])))
  console.log(`\n(${docs.length} document${docs.length === 1 ? '' : 's'})`)
}

/* -------------------------------- commands --------------------------------- */

async function cmdCollections() {
  const d = await db()
  const cols = (await d.listCollections().toArray()).map(c => c.name).sort()
  for (const name of cols) {
    const count = await d.collection(name).estimatedDocumentCount()
    console.log(`${name.padEnd(24)} ${count}`)
  }
}

async function cmdSchema(name) {
  if (!name) throw new Error('usage: schema <collection>')
  const d = await db()
  const idx = await d.collection(name).indexes()
  console.log(`-- indexes on ${name}`)
  for (const i of idx) console.log(`  ${i.name}: ${JSON.stringify(i.key)}${i.unique ? ' UNIQUE' : ''}`)
  const sample = await d.collection(name).findOne({}, { sort: { _id: -1 } })
  console.log(`-- sample document\n${JSON.stringify(sample, null, 2)}`)
}

async function cmdQuery(name, flags) {
  if (!name) throw new Error('usage: query <collection> [--filter J] [--sort J] [--projection J] [--limit N] [--json]')
  const d = await db()
  const limit = flags.limit ? Number(flags.limit) : 20
  const docs = await d.collection(name)
    .find(json(flags.filter), { projection: flags.projection ? json(flags.projection) : undefined })
    .sort(json(flags.sort, { _id: -1 }))
    .limit(limit)
    .toArray()
  printDocs(docs, { json: !!flags.json })
}

async function cmdGet(name, id, flags) {
  if (!name || id === undefined) throw new Error('usage: get <collection> <id> [--json]')
  const d = await db()
  const doc = await d.collection(name).findOne({ _id: coerceId(id) })
  if (!doc) { console.log('(not found)'); return }
  console.log(JSON.stringify(doc, null, 2))
}

async function cmdCount(name, flags) {
  if (!name) throw new Error('usage: count <collection> [--filter J]')
  const d = await db()
  console.log(await d.collection(name).countDocuments(json(flags.filter)))
}

async function cmdUpdate(name, flags) {
  if (!name) throw new Error('usage: update <collection> --filter J --set J [--yes]')
  if (flags.filter === undefined) throw new Error('--filter <json> is required (use {} to match all — deliberately)')
  if (flags.set === undefined) throw new Error('--set <json> is required')
  if (!flags.yes) throw new Error('writes are destructive — re-run with --yes to confirm')
  const d = await db()
  const res = await d.collection(name).updateMany(json(flags.filter), { $set: json(flags.set) })
  console.log(`matched ${res.matchedCount}, modified ${res.modifiedCount}`)
}

async function cmdDelete(name, flags) {
  if (!name) throw new Error('usage: delete <collection> --filter J [--yes]')
  if (flags.filter === undefined) throw new Error('--filter <json> is required (use {} to match all — deliberately)')
  if (!flags.yes) throw new Error('writes are destructive — re-run with --yes to confirm')
  const d = await db()
  const res = await d.collection(name).deleteMany(json(flags.filter))
  console.log(`deleted ${res.deletedCount}`)
}

// Canned read views over commonly-needed collections.
const VIEWS = {
  trades:    { name: 'trades',            filter: {},                       sort: { id: -1 }, limitDefault: 20,
               columns: ['id', 'coin', 'side', 'quantity', 'price', 'total', 'status', 'created_at'] },
  positions: { name: 'positions',         filter: { status: 'OPEN' },       sort: { id: -1 },
               columns: ['id', 'coin', 'side', 'quantity', 'entry_price', 'current_sl', 'take_profit', 'oco_status', 'status', 'pnl'] },
  portfolio: { name: 'portfolio_entries', filter: { status: 'OPEN' },       sort: { coin: 1 },
               columns: ['id', 'coin', 'quantity', 'buy_price', 'status', 'source'] },
  settings:  { name: 'settings',          filter: {},                       sort: { _id: 1 },
               columns: ['_id', 'value'] },
  intents:   { name: 'entry_intents',     filter: {},                       sort: { coin: 1 },
               columns: ['coin', 'signal_price', 'target_price', 'notional_usdc', 'atr', 'expires_at'] },
  llm:       { name: 'llm_calls',          filter: {},                       sort: { id: -1 }, limitDefault: 20,
               columns: ['id', 'module', 'model', 'error_code', 'error_status', 'error', 'duration_ms', 'created_at'] },
}

async function cmdView(view, arg, flags) {
  const v = VIEWS[view]
  const d = await db()
  const limit = arg && /^\d+$/.test(arg) ? Number(arg) : (v.limitDefault ?? 0)
  let cursor = d.collection(v.name).find(v.filter, { projection: Object.fromEntries(v.columns.map(c => [c, 1])) }).sort(v.sort)
  if (limit) cursor = cursor.limit(limit)
  printDocs(await cursor.toArray(), { json: !!flags.json, columns: v.columns })
}

const HELP = `Agent DB tool — inspect & manage the bot's MongoDB data.

Usage: node tools/db.mjs <command> [args] [--flags]

Read (safe any time):
  collections                  List collections with document counts
  schema <collection>          Indexes + a sample document
  query <collection> [--filter J] [--sort J] [--projection J] [--limit N] [--json]
                               Find documents (J = JSON, e.g. '{"status":"OPEN"}')
  get <collection> <id> [--json]
                               Fetch one document by _id (int or string key)
  count <collection> [--filter J]
  trades [N] [--json]          Recent trades (default 20)
  positions [--json]           Open positions
  portfolio [--json]           Open portfolio (ledger) entries
  settings [--json]            All settings key/values
  intents [--json]             Active entry-timing intents
  llm [N] [--json]             Recent LLM calls

Write (live — Mongo is shared, no backend stop needed; --yes required):
  update <collection> --filter J --set J --yes     updateMany($set)
  delete <collection> --filter J --yes             deleteMany

Connection: ${MONGO_URL}  db=${MONGO_DB}
  (override with MONGO_URL / MONGO_DB env vars)
`

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { flags, positional } = parseArgs(rest)
  switch (cmd) {
    case undefined:
    case 'help': case '--help': case '-h': console.log(HELP); break
    case 'collections': case 'tables': await cmdCollections(); break
    case 'schema': await cmdSchema(positional[0]); break
    case 'query': case 'find': await cmdQuery(positional[0], flags); break
    case 'get': await cmdGet(positional[0], positional[1], flags); break
    case 'count': await cmdCount(positional[0], flags); break
    case 'update': await cmdUpdate(positional[0], flags); break
    case 'delete': await cmdDelete(positional[0], flags); break
    case 'trades': case 'positions': case 'portfolio':
    case 'settings': case 'intents': case 'llm':
      await cmdView(cmd, positional[0], flags); break
    default:
      console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exitCode = 2
  }
}

main()
  .catch(err => { console.error(`error: ${err.message}`); process.exitCode = 1 })
  .finally(close)
