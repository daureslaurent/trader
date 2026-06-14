import { ClientSession } from 'mongodb'
import { getDb } from './client.js'

// SQLite gave us INTEGER PRIMARY KEY AUTOINCREMENT. Many rows reference each
// other by that integer id (signal_id, entry_id, exit_id, position_id,
// triggered_trade_id, conversation_id…), so we preserve integer ids in Mongo
// rather than switching to ObjectId. A single `counters` collection holds the
// last-issued id per collection and hands out the next one atomically.
const COUNTERS = 'counters'

export async function nextId(collection: string, session?: ClientSession): Promise<number> {
  const res = await getDb()
    .collection<{ _id: string; seq: number }>(COUNTERS)
    .findOneAndUpdate(
      { _id: collection },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after', session },
    )
  if (!res) throw new Error(`Failed to allocate id for "${collection}"`)
  return res.seq
}

// After a bulk import (the SQL→Mongo migration), seed each counter to the max
// id already present so freshly issued ids never collide with imported rows.
export async function seedCounter(collection: string, value: number): Promise<void> {
  if (!Number.isFinite(value) || value <= 0) return
  await getDb()
    .collection<{ _id: string; seq: number }>(COUNTERS)
    .updateOne(
      { _id: collection },
      { $max: { seq: Math.floor(value) } },
      { upsert: true },
    )
}
