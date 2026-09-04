import { test, after } from 'node:test'
import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { MongoClient } from 'mongodb'
import makeFixture from 'dumpster-lib/fixture'
import dumpsterDoc from '../src/index.js'

// needs a running mongod:   MONGO_URL=mongodb://127.0.0.1:27017 npm test
const url = process.env.MONGO_URL
const fixture = makeFixture(400)
after(() => rmSync(fixture.dir, { recursive: true, force: true }))

test('a dump lands as one document per article', { skip: !url && 'set MONGO_URL to run' }, async () => {
  const dbName = 'dumpster_doc_test'
  const collectionName = 'pages_' + Date.now()
  const stats = await dumpsterDoc({ file: fixture.file, url, dbName, collectionName, format: 'sm', heartbeat: 0, lang: 'en', workers: 3, batchPageCount: 25 })
  assert.equal(stats.written, fixture.expect.articles.length)

  const client = new MongoClient(url)
  const col = client.db(dbName).collection(collectionName)
  assert.equal(await col.countDocuments(), fixture.expect.articles.length)
  const doc = await col.findOne({ _id: '1' })
  assert.equal(doc.title, 'Page 1')
  await col.drop()
  await client.close()
})

test('an unreachable mongo rejects, instead of parsing on', async () => {
  const bad = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300'
  await assert.rejects(dumpsterDoc({ file: fixture.file, url: bad, format: 'text', heartbeat: 0, lang: 'en', workers: 2 }))
})
