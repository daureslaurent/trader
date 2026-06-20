#!/usr/bin/env node
// Agent DB tool — inspect the bot's data over the backend's read-only debug API.
//
// This tool no longer touches MongoDB directly. Instead it calls the backend's
// read-only debug API (/api/debug/*), authenticated with a debug API key. That
// means it works without any database access or credentials — ideal for AI-driven
// debugging. Because the API is read-only, this tool is read-only too: the old
// update/delete commands are gone (do ad-hoc writes with mongosh as a human).
//
// Configuration (env, or a tools/.env file):
//   BOT_API_URL   backend base URL (default http://localhost:3000)
//   BOT_API_KEY   a key created in Settings → API Keys (required)
// See tools/README.md and tools/.env.example.

import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------------- env / .env -------------------------------- */

// Minimal dependency-free .env loader: KEY=VALUE lines, '#' comments, optional
// surrounding quotes. Existing process.env always wins (never overridden).
function loadDotEnv(file) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (key in process.env) continue
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
}
loadDotEnv(path.join(__dirname, '.env'))

const BOT_API_URL = (process.env.BOT_API_URL || 'http://localhost:3000').replace(/\/$/, '')
const BOT_API_KEY = process.env.BOT_API_KEY || ''

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

// Validate a --filter/--sort/--projection JSON flag; '' / true → undefined.
function jsonFlag(flag) {
  if (flag === undefined || flag === true || flag === '') return undefined
  try { JSON.parse(flag) }
  catch (e) { throw new Error(`invalid JSON: ${flag}\n  ${e.message}`) }
  return flag
}

// GET a debug endpoint. `params` values are passed as query string as-is. Throws
// an Error (with `.status` on an HTTP error) on failure.
async function api(pathname, params = {}) {
  if (!BOT_API_KEY) {
    throw new Error('BOT_API_KEY is not set — create one in Settings → API Keys and put it in tools/.env')
  }
  const url = new URL(`${BOT_API_URL}/api/debug/${pathname}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  let res
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${BOT_API_KEY}` } })
  } catch (e) {
    throw new Error(`cannot reach backend at ${BOT_API_URL} — is it running? (${e.message})`)
  }
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
  if (!res.ok) {
    if (res.status === 401) {
      const err = new Error('unauthorized (401) — check BOT_API_KEY in tools/.env (was the key revoked?)')
      err.status = 401
      throw err
    }
    const msg = (body && body.error) || `HTTP ${res.status}`
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  return body
}

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
  const stats = await api('collections')
  for (const c of stats.collections) {
    console.log(`${c.name.padEnd(24)} ${String(c.count).padStart(8)}${c.cache ? '  (cache)' : ''}`)
  }
  console.log(`\ndb=${stats.db}  total=${stats.totalDocs}`)
}

async function cmdSchema(name) {
  if (!name) throw new Error('usage: schema <collection>')
  const { indexes, sample } = await api(`schema/${encodeURIComponent(name)}`)
  console.log(`-- indexes on ${name}`)
  for (const i of indexes) console.log(`  ${i.name}: ${JSON.stringify(i.key)}${i.unique ? ' UNIQUE' : ''}`)
  console.log(`-- sample document\n${JSON.stringify(sample, null, 2)}`)
}

async function cmdQuery(name, flags) {
  if (!name) throw new Error('usage: query <collection> [--filter J] [--sort J] [--projection J] [--limit N] [--json]')
  const docs = await api(`query/${encodeURIComponent(name)}`, {
    filter: jsonFlag(flags.filter),
    sort: jsonFlag(flags.sort),
    projection: jsonFlag(flags.projection),
    limit: flags.limit && flags.limit !== true ? flags.limit : undefined,
  })
  printDocs(docs, { json: !!flags.json })
}

async function cmdGet(name, id) {
  if (!name || id === undefined) throw new Error('usage: get <collection> <id> [--json]')
  try {
    const doc = await api(`get/${encodeURIComponent(name)}/${encodeURIComponent(id)}`)
    console.log(JSON.stringify(doc, null, 2))
  } catch (e) {
    if (e.status === 404) { console.log('(not found)'); return }
    throw e
  }
}

async function cmdCount(name, flags) {
  if (!name) throw new Error('usage: count <collection> [--filter J]')
  const { count } = await api(`count/${encodeURIComponent(name)}`, { filter: jsonFlag(flags.filter) })
  console.log(count)
}

// Canned read views — preset query calls over commonly-needed collections.
const VIEWS = {
  trades:    { name: 'trades',            filter: {},                 sort: { id: -1 }, limitDefault: 20,
               columns: ['id', 'coin', 'side', 'quantity', 'price', 'total', 'status', 'created_at'] },
  positions: { name: 'positions',         filter: { status: 'OPEN' }, sort: { id: -1 },
               columns: ['id', 'coin', 'side', 'quantity', 'entry_price', 'current_sl', 'take_profit', 'oco_status', 'status', 'pnl'] },
  portfolio: { name: 'portfolio_entries', filter: { status: 'OPEN' }, sort: { coin: 1 },
               columns: ['id', 'coin', 'quantity', 'buy_price', 'status', 'source'] },
  settings:  { name: 'settings',          filter: {},                 sort: { _id: 1 },
               columns: ['_id', 'value'] },
  intents:   { name: 'entry_intents',     filter: {},                 sort: { coin: 1 },
               columns: ['coin', 'signal_price', 'target_price', 'notional_usdc', 'atr', 'expires_at'] },
  llm:       { name: 'llm_calls',          filter: {},                sort: { id: -1 }, limitDefault: 20,
               columns: ['id', 'module', 'model', 'error_code', 'error_status', 'error', 'duration_ms', 'created_at'] },
}

async function cmdView(view, arg, flags) {
  const v = VIEWS[view]
  const limit = arg && /^\d+$/.test(arg) ? Number(arg) : (v.limitDefault ?? 0)
  const projection = Object.fromEntries(v.columns.map(c => [c, 1]))
  const docs = await api(`query/${v.name}`, {
    filter: JSON.stringify(v.filter),
    sort: JSON.stringify(v.sort),
    projection: JSON.stringify(projection),
    limit: limit || undefined,
  })
  printDocs(docs, { json: !!flags.json, columns: v.columns })
}

const HELP = `Agent DB tool — inspect the bot's data over the read-only debug API.

Usage: node tools/db.mjs <command> [args] [--flags]

Read (the API is read-only — no writes):
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

Backend: ${BOT_API_URL}/api/debug   (auth: BOT_API_KEY from env or tools/.env)
  Create a key in the app: Settings → API Keys.
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
    case 'get': await cmdGet(positional[0], positional[1]); break
    case 'count': await cmdCount(positional[0], flags); break
    case 'trades': case 'positions': case 'portfolio':
    case 'settings': case 'intents': case 'llm':
      await cmdView(cmd, positional[0], flags); break
    case 'update': case 'delete':
      console.error(`'${cmd}' is no longer supported — the debug API is read-only.\n` +
        'Use mongosh directly for ad-hoc writes.'); process.exitCode = 2; break
    default:
      console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exitCode = 2
  }
}

main().catch(err => { console.error(`error: ${err.message}`); process.exitCode = 1 })
