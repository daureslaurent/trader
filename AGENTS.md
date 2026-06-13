# AGENTS.md

Operational guide for AI coding agents working in this repo. Architecture and
code conventions live in [CLAUDE.md](./CLAUDE.md); this file covers **running and
inspecting the app safely** while you work.

## Toolkit: `tools/`

Two zero-setup CLIs wrap the fiddly bits (split databases, root-owned files, an
in-memory DB the live bot will overwrite) so you don't write one-off scripts:

```bash
node tools/db.mjs  <command>   # inspect / mutate the SQLite databases
node tools/app.mjs <command>   # start / stop / logs / lint the dockerized app
```

Run `node tools/db.mjs help` / `node tools/app.mjs help` for full usage. Full
docs: [tools/README.md](./tools/README.md).

## The one rule that bites: how the database works

The backend uses **sql.js** — all four databases are held in memory and persisted
to `data/*.db`. This has three consequences you must respect:

1. **The schema is split across four files** — `settings.db`, `trading.db`,
   `pipeline.db`, `cache.db`. Each table lives in exactly one. `node tools/db.mjs find <table>` tells you which.
2. **`data/*.db` is root-owned** (the container runs as root, bind-mounting `./data`).
   You can read it locally but cannot write it locally.
3. **A running backend overwrites direct file edits** on its next save.

➡️ **Never edit `data/*.db` by hand while the bot is running.** Reads are safe;
for writes use `db.mjs exec`, which stops the backend, backs up the file, mutates
it inside the container, and restarts the backend.

## Common tasks

```bash
# Inspect
node tools/db.mjs tables
node tools/db.mjs trades 10
node tools/db.mjs positions
node tools/db.mjs query "SELECT coin, status, pnl FROM positions WHERE status='OPEN'"

# Mutate (destructive — requires --db and --yes; auto-backs up)
node tools/db.mjs exec "DELETE FROM trades WHERE id = 54" --db trading --yes

# App lifecycle
node tools/app.mjs status
node tools/app.mjs logs backend 200
node tools/app.mjs restart backend
node tools/app.mjs lint          # backend type-check — the only automated gate
```

## Gotchas (learned the hard way — don't repeat these)

These are real mistakes made while operating `tools/db.mjs`. The tool has since
been hardened against them, but the habits still save you a round-trip:

- **Don't assume column names.** They aren't always what you'd guess — e.g.
  `pipeline_events` stores the coin as `coin`, not `symbol`. Check
  `node tools/db.mjs schema <table>` before writing a query. (`query` now reports
  the *real* error from whichever db owns the table — e.g. `no such column:
  symbol` — instead of masking it behind another db's `no such table`. A `no
  matching table in …` message means the table name itself is wrong.)
- **Wide JSON/TEXT columns are truncated in table output, not dumped.**
  `pipeline_events.data` and similar blobs once flooded the terminal with 437 KB;
  table output now caps each cell at 200 chars. Still prefer selecting the scalar
  columns you need (`id, stage, coin, created_at`); use `--json` when you actually
  need a full blob value.

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
