// Public database API. The data layer is MongoDB (native driver) behind a thin
// per-collection Repository. Import collections and helpers from here only —
// never reach into the driver or a repository's internals directly.
export { initDB, shutdownDB } from './connection.js'
export { getDb, getClient, connectMongo, closeMongo } from './client.js'
export { withTransaction } from './transaction.js'
export { nowSql } from './time.js'
export { nextId, seedCounter } from './counters.js'
export { getSettings, updateSetting, loadSettings, getRawSetting } from './settings.js'
export { runLLMRetention } from './llm-retention.js'
export { runDataRetention } from './retention.js'
export { ensureIndexes } from './indexes.js'
export {
  exportCollections, importCollections, resolveExportSelection, knownCollections,
  getDbStats, clearCaches, reseedCounters, CACHE_COLLECTIONS,
} from './backup.js'
export type { ExportFile, ImportResult, DbStats } from './backup.js'
export { Repository } from './repository.js'
export type { WriteOpts } from './repository.js'
export type { Row } from './repositories.js'
export * from './repositories.js'
