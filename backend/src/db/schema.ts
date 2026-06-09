import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const SQL_DIR = path.join(fileURLToPath(import.meta.url), '..', 'sql')

function loadDir(dir: string): string {
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n')
}

export const SCHEMAS: Record<string, string> = {
  settings: loadDir(path.join(SQL_DIR, 'settings')),
  trading:  loadDir(path.join(SQL_DIR, 'trading')),
  pipeline: loadDir(path.join(SQL_DIR, 'pipeline')),
  cache:    loadDir(path.join(SQL_DIR, 'cache')),
}
