# dumpster-doc

a batch writer for pushing high volumes of json into mongodb — built for wikipedia-dump parsing, where a pool of workers each pause their reader, hand off a batch of parsed articles, and resume once the batch is safely on the server.

it is append-only by design: no reads, no updates, just fast unordered inserts.

```js
import write, { init, close, stats } from './src/index.js'

init({ dbName: 'wikipedia', collectionName: 'articles' }) // optional

// in each worker's batch callback:
await write(articles) // resolves when mongodb has the batch → resume the reader

// once, at the end of the run:
console.log(stats()) // { batches: 812, inserted: 4051233, duplicates: 12 }
await close()
```

### install

```bash
pnpm add mongodb
```

## API

### `write(articles)` — default export

writes one array of objects as individual documents. returns a promise that resolves to `{ inserted, duplicates }` once the server has acknowledged the batch.

the promise **is** the backpressure signal — keep your reader paused until it resolves.

- each article's `id` property is stored as mongo's `_id` (see below)
- articles that share an `_id` with an already-written document are counted as `duplicates`, not errors
- real failures (connection loss, a document over mongo's 16mb cap, ...) reject. don't resume the reader — the same batch can be safely re-sent, even if it partially landed
- arrays of any size are fine; the driver splits them at the wire-protocol limits (100k ops / 48mb per message)

### `init(options)`

optional. call it before the first `write()`.

| option           | default                      | env var            |
| ---------------- | ---------------------------- | ------------------ |
| `url`            | `mongodb://127.0.0.1:27017`  | `MONGO_URL`        |
| `dbName`         | `wikipedia`                  | `MONGO_DB`         |
| `collectionName` | `articles`                   | `MONGO_COLLECTION` |
| `useIdAsKey`     | `true`                       |                    |
| `maxPoolSize`    | `10`                         |                    |
| `writeConcern`   | `{ w: 1, journal: false }`   |                    |

### `stats()`

running totals for this process: `{ batches, inserted, duplicates }`.

### `close()`

drains the connection pool. call once when the run is finished (each worker process should call its own).

## design notes

**`id` becomes `_id`** — mongo indexes `_id` no matter what, so reusing the article id means one index instead of two, free lookups by id later, and idempotent writes: a re-sent batch just bounces off as duplicate-key errors, which are swallowed and counted. that's what makes "retry the whole batch on any failure" safe. articles without an `id` (or with an existing `_id`) pass through untouched. set `useIdAsKey: false` to keep `id` as a plain field instead.

**unordered inserts** — batches go in with `ordered: false`, so the server applies documents in parallel and keeps going past individual failures instead of aborting the rest of the batch.

**relaxed write concern** — `{ w: 1, journal: false }` is acknowledged by the primary but doesn't wait for the journal fsync on every batch. a mongod crash can lose the last ~100ms of writes; since writes are idempotent, a re-run of the dump repairs that for free. pass a stricter `writeConcern` to `init()` if you'd rather wait.

**no internal buffering** — one call, one `insertMany`. nothing is held in memory here, so a crash never eats a batch silently, and pause/resume semantics stay honest.

**one client per process** — the connection is made lazily on the first `write()` and shared. a failed connect doesn't poison later calls, so workers may start before mongod does.

ISC
