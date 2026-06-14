# tools/ — agent operations toolkit

Small, scriptable CLIs for an AI agent (or a human) to inspect the bot's data and
manage its lifecycle without hand-writing one-off SQL scripts each time. Two
tools, no dependencies beyond what `backend/` and Docker already provide.

```
node tools/db.mjs  <command> [args] [--flags]   # inspect / mutate the databases
node tools/app.mjs <command> [args]             # start / stop / logs / lint
```

## Why this exists (the data model that makes naïve edits dangerous)

The backend uses **sql.js**: each of the four databases is loaded fully into
memory and written back to `data/*.db` on a debounced save and on shutdown.

- The schema is **namespaced across four files** — `settings.db`, `trading.db`,
  `pipeline.db`, `cache.db`. One table lives in exactly one file. Use
  `db.mjs find <table>` if unsure.
- The `data/*.db` files are **owned by root** (the container runs as root and
  bind-mounts `./data`). A local non-root process can *read* them but not write.
- A **running backend will clobber any direct file edit** the next time it saves,
  because its in-memory copy is authoritative.

So: **reads are done locally and read-only**; **writes stop the backend, back up
the file, mutate it inside the backend container, then restart the backend.**
`db.mjs exec` does all of that for you — never edit `data/*.db` by hand while the
bot is up.

## db.mjs

### Read (safe any time)

```bash
node tools/db.mjs tables                 # tables grouped by db file
node tools/db.mjs find trades            # -> trading.db
node tools/db.mjs schema positions       # CREATE TABLE statement
node tools/db.mjs query "SELECT coin, SUM(total) FROM trades GROUP BY coin"
node tools/db.mjs query "SELECT * FROM settings WHERE key LIKE 'entry_%'" --json

# canned views
node tools/db.mjs trades 10              # last 10 trades
node tools/db.mjs positions             # open positions
node tools/db.mjs portfolio             # open ledger entries
node tools/db.mjs settings
node tools/db.mjs intents               # active entry-timing intents
node tools/db.mjs llm 20                 # recent LLM calls
```

`query` is restricted to `SELECT`/`WITH`/`PRAGMA`/`EXPLAIN` and auto-routes across
all four dbs (override with `--db <name>`). Add `--json` for machine-readable output.

Two safeguards: auto-routing surfaces the *real* error from whichever db owns the
table (a bad column won't be hidden behind another db's `no such table`); and wide
JSON/TEXT cells are truncated to 200 chars in table output — use `--json` to get a
full value.

### Write (stops the bot, backs up, mutates, restarts)

```bash
node tools/db.mjs exec "DELETE FROM trades WHERE id = 54" --db trading --yes
node tools/db.mjs exec "UPDATE positions SET status='CLOSED' WHERE id=16" --db trading --yes
```

- `--db <settings|trading|pipeline|cache>` is **required** (no auto-routing for writes).
- `--yes` is **required** to confirm the destructive operation.
- A timestamped backup `data/<db>.db.bak-<iso>` is created first. To roll back:
  stop the backend, restore the `.bak-*` file over `data/<db>.db`, start the backend.
- If the backend was running it is stopped for the edit and restarted afterward;
  if it was already stopped it stays stopped.

## app.mjs

```bash
node tools/app.mjs status               # docker compose ps
node tools/app.mjs logs backend 200     # last 200 lines
node tools/app.mjs follow backend       # stream logs
node tools/app.mjs restart backend
node tools/app.mjs stop  | start | down | up
node tools/app.mjs lint                 # backend type-check (the only test gate)
```

## Notes

- Both tools resolve the repo and `data/` relative to their own location, so they
  work from any cwd.
- `db.mjs` borrows `sql.js` from `backend/node_modules` — run after `npm install`
  in `backend/`. No separate install needed.
- The `_exec-raw` subcommand of `db.mjs` is the in-container half of a write and
  is not meant to be called directly.
- Backups (`*.db.bak-*`) accumulate in `data/`; prune old ones when convenient.
