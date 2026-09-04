import dumpsterDoc from './src/index.js'

const stats = await dumpsterDoc({
  url: 'mongodb://127.0.0.1:27017',
  dbName: 'wikipedia',
  collectionName: 'articles',
  project: 'wikipedia',
  lang: 'sw',
  format: 'sm',
  batchPageCount: 100,
  file: '/Volumes/4TB/wikipedia/swwiki-latest-pages-articles.xml',
})
console.log('dumpster-doc end', stats)
