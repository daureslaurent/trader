# tools/ — agent operations toolkit

Small, scriptable CLIs for an AI agent (or a human) to inspect the bot's data and
manage its lifecycle. Two tools, no dependencies beyond what `backend/` and Docker
already provide.

```
node tools/db.mjs  <command> [args] [--flags]   # inspect data over the debug API
node tools/app.mjs <command> [args]             # start / stop / logs / lint
```

## db.mjs

`db.mjs` inspects the bot's data over the backend's **read-only debug API**
(`/api/debug/*`) — it does **not** connect to MongoDB directly, so it needs no
database access or credentials. This makes it safe for AI-driven debugging.

Because the API is read-only, **`db.mjs` is read-only**: the old `update`/`delete`
commands are gone. For ad-hoc writes, use `mongosh` directly as a human.

### Configuration

Set these in the environment or in a `tools/.env` file (see `tools/.env.example`):

| Var | Default | Purpose |
| --- | --- | --- |
| `BOT_API_URL` | `http://localhost:3000` | Backend base URL |
| `BOT_API_KEY` | _(required)_ | A key created in the app: **Settings → API Keys → Create key** (shown once) |

```bash
cp tools/.env.example tools/.env
# then paste your key into BOT_API_KEY
```

Filters/sorts/projections are passed as JSON strings.

### Read

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
table output truncates wide cells to 200 chars (use `--json` for full values). The
server clamps `--limit` to a maximum of 500.

Document ids: most collections keep an integer `_id` (mirrored as `id`); a few use
a natural string key (`settings`→key, `monitor_notes`→coin, `entry_intents`/
`entry_events`→id, `extraction_cache`→url, `ohlcv_cache`→cache_key). `get` coerces
a numeric argument to an int `_id`, otherwise treats it as a string key.

Only the app's known collections are queryable (the debug API whitelists them), so
secret/system collections such as `app_config` are intentionally not reachable.

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

- Both tools resolve the repo relative to their own location (and `db.mjs` loads
  `tools/.env`), so they work from any cwd.
- `db.mjs` has no dependencies — it uses the built-in `fetch` (Node 18+) against
  the backend's debug API. The backend must be running and a `BOT_API_KEY` set.
- One-off import of legacy sql.js data: `cd backend && npm run migrate:mongo`.
