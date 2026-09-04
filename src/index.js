import dumpster from 'dumpster-lib'
import write, { init, close, stats } from './write.js'

// options for the mongo writer, picked out of the ones you pass in
const mongoKeys = ['url', 'dbName', 'collectionName', 'useIdAsKey', 'maxPoolSize', 'writeConcern']

// a dumpster-lib page → a document. `id` becomes mongo's `_id` (see write.js)
const toDoc = ({ pageID, ...page }) => ({ id: pageID, ...page })

const dumpsterDoc = (options = {}) => {
  init(Object.fromEntries(mongoKeys.filter((k) => options[k] !== undefined).map((k) => [k, options[k]])))
  const pool = dumpster(options)
  // write() resolves once mongo has acknowledged the batch, so the pool waits for that before handing over the next
  pool.on('batch', (pages) => write(pages.map(toDoc)))
  // drain the connection pool, after the last batch
  pool.on('end', () => close())
  return pool.done
}

export default dumpsterDoc
export { write, init, close, stats }
