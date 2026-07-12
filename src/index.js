import { MongoClient } from 'mongodb'

/**
 * Append-only batch writer for MongoDB, built for high-volume bulk ingestion
 * (no reads) from a pool of dump-parsing workers.
 *
 *   import write, { init, close, stats } from './src/index.js'
 *
 *   init({ dbName: 'wikipedia', collectionName: 'articles' }) // optional
 *   await write(articles) // resolved promise = batch is on the server, resume the reader
 *   await close()         // once, at the end of the run
 *
 * Design notes:
 *  - No internal buffering. Each call maps to one unordered insertMany, and the
 *    returned promise is the backpressure signal — the worker's paused reader
 *    should not resume until it resolves.
 *  - Each article's `id` is stored as Mongo's `_id`. One index instead of two,
 *    and it makes writes idempotent: a re-sent batch just produces duplicate-key
 *    errors, which are swallowed and counted. A batch that throws can therefore
 *    be retried whole, even if it partially succeeded.
 *  - The driver splits oversized batches automatically (100k ops / 48MB per
 *    message). The only hard limit is 16MB per individual document.
 */

const defaults = {
  url: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017',
  dbName: process.env.MONGO_DB || 'wikipedia',
  collectionName: process.env.MONGO_COLLECTION || 'articles',
  // store each article's `id` property as the document's `_id`
  useIdAsKey: true,
  // sockets per process; concurrent write() calls each get their own
  maxPoolSize: 10,
  // acknowledged by the primary, but don't wait for the journal fsync on every
  // batch — a mongod crash can lose the last ~100ms of writes, which a re-run
  // of the dump repairs for free since writes are idempotent
  writeConcern: { w: 1, journal: false },
}

let config = { ...defaults }
let client = null
let connecting = null

const totals = { batches: 0, inserted: 0, duplicates: 0 }

/** Optional. Must be called before the first write(). */
export function init(options = {}) {
  if (connecting) {
    throw new Error('init() must be called before the first write()')
  }
  config = { ...defaults, ...options }
}

async function connect() {
  if (!connecting) {
    connecting = (async () => {
      client = new MongoClient(config.url, {
        maxPoolSize: config.maxPoolSize,
        // drop undefined values instead of storing them as null
        ignoreUndefined: true,
      })
      await client.connect()
      return client.db(config.dbName).collection(config.collectionName, {
        writeConcern: config.writeConcern,
      })
    })()
    // a failed connect (mongod not up yet) must not poison every later call
    connecting.catch(() => {
      connecting = null
      client = null
    })
  }
  return connecting
}

function withIdAsKey(article) {
  if (article === null || typeof article !== 'object') return article
  if (article._id !== undefined || article.id === undefined) return article
  const { id, ...rest } = article
  return { _id: id, ...rest }
}

/**
 * Write one batch of articles as individual documents.
 *
 * Resolves with { inserted, duplicates } once the server has acknowledged the
 * batch. Rejects on real failures (connection loss, oversized document, ...) —
 * do not resume the reader on rejection; the same batch can be safely re-sent.
 *
 * @param {object[]} articles
 * @returns {Promise<{inserted: number, duplicates: number}>}
 */
export default async function write(articles) {
  if (!Array.isArray(articles)) {
    throw new TypeError(`write() expects an array of objects, got ${typeof articles}`)
  }
  if (articles.length === 0) {
    return { inserted: 0, duplicates: 0 }
  }
  const collection = await connect()
  const docs = config.useIdAsKey ? articles.map(withIdAsKey) : articles

  let inserted = 0
  let duplicates = 0
  try {
    const res = await collection.insertMany(docs, {
      // unordered: the server applies inserts in parallel and keeps going past
      // individual failures instead of aborting the rest of the batch
      ordered: false,
      bypassDocumentValidation: true,
    })
    inserted = res.insertedCount
  } catch (err) {
    const writeErrors = [].concat(err.writeErrors ?? [])
    const fatal = writeErrors.filter((e) => e.code !== 11000)
    if (writeErrors.length === 0 || fatal.length > 0) {
      throw err
    }
    // only duplicate-key errors: the rest of the batch went through
    duplicates = writeErrors.length
    inserted = err.result?.insertedCount ?? docs.length - duplicates
  }

  totals.batches += 1
  totals.inserted += inserted
  totals.duplicates += duplicates
  return { inserted, duplicates }
}

/** Running totals across all write() calls in this process. */
export function stats() {
  return { ...totals }
}

/** Drain the connection pool. Call once when the run is finished. */
export async function close() {
  if (connecting) {
    await connecting.catch(() => {})
  }
  if (client) {
    await client.close()
  }
  client = null
  connecting = null
}
