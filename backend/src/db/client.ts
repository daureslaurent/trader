import { MongoClient, Db } from 'mongodb'
import { logger } from '../core/logger.js'

// The whole app lives in one logical Mongo database. The old SQLite split
// (settings / trading / pipeline / cache) collapses into collections here so
// that a single multi-document transaction can span everything.
// directConnection lets a single-node replica set serve transactions over a
// plain host:port without replica-set host discovery (the rs0 member advertises
// an in-container hostname that the host can't resolve).
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/?directConnection=true'
const DB_NAME = process.env.MONGO_DB || 'cryptobot'

let client: MongoClient | null = null
let db: Db | null = null

export async function connectMongo(): Promise<Db> {
  if (db) return db

  logger.info('Connecting to MongoDB', { url: redactUrl(MONGO_URL), db: DB_NAME })

  client = new MongoClient(MONGO_URL, {
    // Keep writes durable: ack from the (single-node) replica set.
    writeConcern: { w: 'majority' },
    // Fail fast on a misconfigured / down server rather than hanging startup.
    serverSelectionTimeoutMS: 10_000,
  })

  await client.connect()
  db = client.db(DB_NAME)

  // Surface a misconfigured connection early.
  await db.command({ ping: 1 })

  logger.info('MongoDB connected', { db: DB_NAME })
  return db
}

export function getDb(): Db {
  if (!db) throw new Error('MongoDB not initialized. Call connectMongo()/initDB() first.')
  return db
}

export function getClient(): MongoClient {
  if (!client) throw new Error('MongoDB not initialized. Call connectMongo()/initDB() first.')
  return client
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close()
    client = null
    db = null
    logger.info('MongoDB connection closed')
  }
}

// Never log credentials embedded in a connection string.
function redactUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@')
}
