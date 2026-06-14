# AGENTS.md

Operational guide for AI coding agents working in this repo. Architecture and
code conventions live in [CLAUDE.md](./CLAUDE.md); this file covers **running and
inspecting the app safely** while you work.

## Toolkit: `tools/`

Two zero-setup CLIs so you don't write one-off scripts:

```bash
node tools/db.mjs  <command>   # inspect / mutate MongoDB
node tools/app.mjs <command>   # start / stop / logs / lint the dockerized app
```

Run `node tools/db.mjs help` / `node tools/app.mjs help` for full usage. Full
docs: [tools/README.md](./tools/README.md).

## How the database works

The backend stores everything in a single **MongoDB** database (`cryptobot`), one
collection per former table, served by the `mongo` service in docker-compose
(single-node replica set `rs0`, required for transactions). `tools/db.mjs`
connects via `MONGO_URL` (default `mongodb://localhost:27017/?directConnection=true`)
and `MONGO_DB` (default `cryptobot`), borrowing the `mongodb` driver from
`backend/node_modules`.

Unlike the old sql.js files, Mongo is a real shared datastore: **reads and writes
are both safe while the bot is running** — there's no in-memory file copy to
clobber and nothing to stop/back up. Writes are still destructive, so
`update`/`delete` require `--filter` and `--yes`. For a true backup use `mongodump`.

Most collections keep an integer `_id` (mirrored as `id`); a few use a natural
string key (`settings`→key, `monitor_notes`→coin, `entry_intents`/`entry_events`
→id, `extraction_cache`→url, `ohlcv_cache`→cache_key).

## Common tasks

```bash
# Inspect
node tools/db.mjs collections
node tools/db.mjs trades 10
node tools/db.mjs positions
node tools/db.mjs query positions --filter '{"status":"OPEN"}' --projection '{"coin":1,"status":1,"pnl":1}'

# Mutate (destructive — requires --filter and --yes; writes are live)
node tools/db.mjs delete trades --filter '{"id":54}' --yes
node tools/db.mjs update positions --filter '{"id":16}' --set '{"status":"CLOSED"}' --yes

# App lifecycle
node tools/app.mjs status
node tools/app.mjs logs backend 200
node tools/app.mjs restart backend
node tools/app.mjs lint          # backend type-check — the only automated gate

# One-off: import legacy sql.js data into Mongo
cd backend && npm run migrate:mongo
```

## Gotchas (don't repeat these)

- **Don't assume field names.** They aren't always what you'd guess — e.g.
  `pipeline_events` stores the coin as `coin`, not `symbol`. Run
  `node tools/db.mjs schema <collection>` (indexes + a sample document) before
  writing a filter.
- **Wide JSON/TEXT fields are truncated in table output, not dumped.**
  `pipeline_events.data` and similar blobs would flood the terminal; table output
  caps each cell at 200 chars. Prefer `--projection` to select the scalar fields
  you need; use `--json` when you actually need a full blob value.

## Verifying changes

There is **no unit-test runner**. The gates are:

- `node tools/app.mjs lint` — backend `tsc --noEmit`. Always run after backend edits.
- For behavior, run the app (`node tools/app.mjs up` / `restart`), watch
  `node tools/app.mjs logs backend`, and confirm state via `tools/db.mjs`
  (e.g. after a BUY, check `positions`/`portfolio` show the row with `oco_status=ACTIVE`).

## Conventions reminder (see CLAUDE.md for detail)

- Each module's public API is its `index.ts`; never import a module's internal files.
- Cross-module side effects go through the typed event bus (`core/events.ts`).
- Structured logging only: `logger.info('msg', { data })`.
- The quote/base currency is **USDC** (despite some `*Usdt*` legacy names).
