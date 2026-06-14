# tools/ — agent operations toolkit

Small, scriptable CLIs for an AI agent (or a human) to inspect the bot's data and
manage its lifecycle. Two tools, no dependencies beyond what `backend/` and Docker
already provide.

```
node tools/db.mjs  <command> [args] [--flags]   # inspect / mutate MongoDB
node tools/app.mjs <command> [args]             # start / stop / logs / lint
```

## db.mjs

The backend stores everything in a single **MongoDB** database (`cryptobot` by
default), one collection per former table. Mongo is a real shared datastore, so —
unlike the old sql.js files — **both reads and writes are safe while the bot is
running**; there's no in-memory file copy to clobber and nothing to stop/back up.

Connection comes from `MONGO_URL` (default
`mongodb://localhost:27017/?directConnection=true`) and `MONGO_DB` (default
`cryptobot`). The tool borrows the `mongodb` driver from `backend/node_modules`,
so run it after `npm install` in `backend/`. Filters/sorts/updates are passed as
JSON strings.

### Read (safe any time)

```bash
node tools/db.mjs collections            # collections with document counts
node tools/db.mjs schema positions       # indexes + a sample document
node tools/db.mjs query trades --filter '{"status":"EXECUTED"}' --sort '{"id":-1}' --limit 10
node tools/db.mjs query settings --filter '{"_id":{"$regex":"^entry_"}}' --json
node tools/db.mjs get trades 54          # one document by _id (int or string key)
node tools/db.mjs count positions --filter '{"status":"OPEN"}'

# canned views
node tools/db.mjs trades 10              # last 10 trades
node tools/db.mjs positions             # open positions
node tools/db.mjs portfolio             # open ledger entries
node tools/db.mjs settings
node tools/db.mjs intents               # active entry-timing intents
node tools/db.mjs llm 20                 # recent LLM calls
```

`query` takes a Mongo filter as JSON. Add `--json` for machine-readable output;
table output truncates wide cells to 200 chars (use `--json` for full values).

Document ids: most collections keep an integer `_id` (mirrored as `id`); a few use
a natural string key (`settings`→key, `monitor_notes`→coin, `entry_intents`/
`entry_events`→id, `extraction_cache`→url, `ohlcv_cache`→cache_key). `get` coerces
a numeric argument to an int `_id`, otherwise treats it as a string key.

### Write (live; `--yes` required)

```bash
node tools/db.mjs update positions --filter '{"id":16}' --set '{"status":"CLOSED"}' --yes
node tools/db.mjs delete trades --filter '{"id":54}' --yes
```

- `update` runs `updateMany` with `$set`; `delete` runs `deleteMany`.
- `--filter` is **required** (pass `{}` deliberately to match every document).
- `--yes` is **required** to confirm the destructive operation.
- No stop/backup/restart dance — the write goes straight to the shared server
  while the bot keeps running. For a real backup, use `mongodump`.

## app.mjs

```bash
node tools/app.mjs status               # docker compose ps
node tools/app.mjs logs backend 200     # last 200 lines
node tools/app.mjs follow backend       # stream logs
node tools/app.mjs restart backend
node tools/app.mjs stop  | start | down | up
node tools/app.mjs lint                 # backend type-check (the only test gate)
```

`docker compose up` now also starts the `mongo` service (single-node replica set
`rs0`); its data lives in the `mongo-data` volume.

## Notes

- Both tools resolve the repo relative to their own location, so they work from
  any cwd.
- `db.mjs` borrows `mongodb` from `backend/node_modules` — run after `npm install`
  in `backend/`. No separate install needed.
- One-off import of legacy sql.js data: `cd backend && npm run migrate:mongo`.
