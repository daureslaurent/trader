import {
  ClientSession, Collection, Document, Filter, FindOptions,
  OptionalUnlessRequiredId, UpdateFilter, WithoutId,
} from 'mongodb'
import { getDb } from './client.js'
import { nextId } from './counters.js'

export interface WriteOpts {
  session?: ClientSession
}

/**
 * A thin typed wrapper around a single Mongo collection. Each domain module owns
 * one Repository instance (see repositories.ts). It is intentionally close to the
 * driver — callers still write Mongo filters/updates — but centralizes the two
 * cross-cutting concerns: integer-id allocation on insert and session plumbing.
 *
 * `autoId` collections (the old INTEGER PRIMARY KEY AUTOINCREMENT tables) get an
 * integer `_id` from the counters collection on insert. Collections with a
 * natural string key (settings.key, extraction_cache.url, entry_intents.id…)
 * set autoId: false and provide their own `_id`.
 */
export class Repository<T extends Document & { _id?: number | string }> {
  constructor(
    public readonly name: string,
    private readonly autoId: boolean = true,
  ) {}

  col(): Collection<T> {
    return getDb().collection<T>(this.name)
  }

  async findOne(filter: Filter<T> = {}, opts: FindOptions<T> & WriteOpts = {}): Promise<T | null> {
    return (await this.col().findOne(filter, opts)) as T | null
  }

  async findById(id: number | string, opts: WriteOpts = {}): Promise<T | null> {
    return this.findOne({ _id: id } as Filter<T>, opts)
  }

  async find(filter: Filter<T> = {}, opts: FindOptions<T> & WriteOpts = {}): Promise<T[]> {
    return (await this.col().find(filter, opts).toArray()) as T[]
  }

  async count(filter: Filter<T> = {}, opts: WriteOpts = {}): Promise<number> {
    return this.col().countDocuments(filter, opts)
  }

  /** Insert one doc, allocating an integer id when this is an autoId collection.
   *  For autoId collections the integer is stored as both `_id` and `id` (they are
   *  immutable, so they never drift) so call sites can keep reading/filtering on
   *  `id`. Returns the inserted id. */
  async insert(doc: WithoutId<T> | T, opts: WriteOpts = {}): Promise<number | string> {
    const toInsert: Record<string, unknown> = { ...(doc as Record<string, unknown>) }
    if (this.autoId && toInsert._id === undefined) {
      const id = await nextId(this.name, opts.session)
      toInsert._id = id
      toInsert.id = id
    }
    const res = await this.col().insertOne(
      toInsert as OptionalUnlessRequiredId<T>,
      { session: opts.session },
    )
    return res.insertedId as unknown as number | string
  }

  async insertMany(docs: (WithoutId<T> | T)[], opts: WriteOpts = {}): Promise<void> {
    if (docs.length === 0) return
    const prepared: Record<string, unknown>[] = []
    for (const d of docs) {
      const doc: Record<string, unknown> = { ...(d as Record<string, unknown>) }
      if (this.autoId && doc._id === undefined) {
        const id = await nextId(this.name, opts.session)
        doc._id = id
        doc.id = id
      }
      prepared.push(doc)
    }
    await this.col().insertMany(prepared as OptionalUnlessRequiredId<T>[], { session: opts.session })
  }

  /** Returns number of documents matched. */
  async update(filter: Filter<T>, update: UpdateFilter<T> | Partial<T>, opts: WriteOpts = {}): Promise<number> {
    const res = await this.col().updateOne(filter, asUpdate(update), { session: opts.session })
    return res.matchedCount
  }

  async updateMany(filter: Filter<T>, update: UpdateFilter<T> | Partial<T>, opts: WriteOpts = {}): Promise<number> {
    const res = await this.col().updateMany(filter, asUpdate(update), { session: opts.session })
    return res.matchedCount
  }

  /** Upsert by _id (used for key/value-style collections). */
  async upsert(id: number | string, set: Partial<T>, opts: WriteOpts = {}): Promise<void> {
    await this.col().updateOne(
      { _id: id } as Filter<T>,
      { $set: set, $setOnInsert: { _id: id } } as unknown as UpdateFilter<T>,
      { upsert: true, session: opts.session },
    )
  }

  async deleteOne(filter: Filter<T>, opts: WriteOpts = {}): Promise<number> {
    const res = await this.col().deleteOne(filter, { session: opts.session })
    return res.deletedCount
  }

  async deleteMany(filter: Filter<T>, opts: WriteOpts = {}): Promise<number> {
    const res = await this.col().deleteMany(filter, { session: opts.session })
    return res.deletedCount
  }

  aggregate<R extends Document = Document>(pipeline: Document[], opts: WriteOpts = {}): Promise<R[]> {
    return this.col().aggregate<R>(pipeline, { session: opts.session }).toArray()
  }
}

// Allow callers to pass either a plain field map (treated as $set) or a full
// Mongo update document ($set/$inc/$max…).
function asUpdate<T extends Document>(update: UpdateFilter<T> | Partial<T>): UpdateFilter<T> {
  const hasOperator = Object.keys(update).some(k => k.startsWith('$'))
  return (hasOperator ? update : { $set: update }) as UpdateFilter<T>
}
