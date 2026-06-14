import { ClientSession } from 'mongodb'
import { getClient } from './client.js'

/**
 * Run all writes in fn() inside a single Mongo multi-document transaction and
 * commit atomically (or roll back on any throw). Requires the server to be a
 * replica set — docker-compose runs mongod as a single-node RS (rs0) for this.
 *
 * This replaces the old synchronous sql.js withTransaction(). Every repository
 * write accepts an optional `session`; pass the one handed to fn() so the writes
 * enroll in the transaction. The single choke point submitTrade() relies on this
 * to keep trade + position + portfolio rows consistent.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = getClient().startSession()
  try {
    let result: T
    await session.withTransaction(async () => {
      result = await fn(session)
    })
    return result!
  } finally {
    await session.endSession()
  }
}
