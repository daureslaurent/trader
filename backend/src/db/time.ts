// SQLite stored created_at as datetime('now') → 'YYYY-MM-DD HH:MM:SS' in UTC.
// A lot of code sorts and compares these as plain strings, so we keep the exact
// same textual format in Mongo instead of switching to native Date/ISO. This is
// the single source of truth for "now as the DB writes it".
export function nowSql(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}
