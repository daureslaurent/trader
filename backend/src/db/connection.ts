import { connectMongo, closeMongo } from './client.js'
import { ensureIndexes } from './indexes.js'
import { logger } from '../core/logger.js'

// Initialize the database layer: open the Mongo connection and ensure indexes.
// Unlike the old sql.js layer there is no schema-creation step (collections are
// created lazily on first write) and no on-disk save/migration machinery — the
// server persists every write itself.
export async function initDB(): Promise<void> {
  await connectMongo()
  await ensureIndexes()
  logger.info('Database initialized (MongoDB)')
}

// Graceful-shutdown hook. sql.js needed an explicit flush-to-disk; Mongo just
// needs the client closed cleanly.
export async function shutdownDB(): Promise<void> {
  await closeMongo()
}
