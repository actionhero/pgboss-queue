# pg-queue

**Background jobs in Node.js, backed by Postgres.**

`pg-queue` is a queue-based job system with the same Worker / Scheduler / Queue API as [node-resque](https://github.com/actionhero/node-resque): priority queues, delayed jobs, plugins, locking, failed-job management, and a leader-elected scheduler. Storage is PostgreSQL (`SELECT … FOR UPDATE SKIP LOCKED`), not Redis.

```ts
import { Queue, Worker, Scheduler, Plugins } from "pg-queue";

const connection = {
  connectionString: process.env.DATABASE_URL,
};

const jobs = {
  add: {
    plugins: [Plugins.JobLock],
    perform: async (a: number, b: number) => a + b,
  },
  subtract: {
    perform: (a: number, b: number) => a - b,
  },
};

const worker = new Worker({ connection, queues: ["math", "otherQueue"] }, jobs);
const scheduler = new Scheduler({ connection });
const queue = new Queue({ connection }, jobs);

await worker.connect();
await scheduler.connect();
await queue.connect();

worker.start();
scheduler.start();

await queue.enqueue("math", "add", [1, 2]);
await queue.enqueueIn(3000, "math", "subtract", [2, 1]);
```

Call `await worker.end()`, `await scheduler.end()`, and `await queue.end()` before shutting down so workers leave the cluster cleanly.

## How it works

Resque-style processing: workers pull one job at a time from queues and run it to completion (or failure).

- **Queues** hold jobs in order. There are regular work queues, delayed jobs (not eligible until a time), and a failed-job set.
- **Workers** are assigned one or more queues. Queue order is priority: `["math", "low"]` drains `math` before `low`. Use `queues: "*"` to work every queue.
- **Scheduler** does not run jobs. You should run many scheduler processes; **one is elected leader**. The leader makes delayed jobs eligible, cleans stuck workers, migrates the schema when `automigrate` is on, and deletes completed jobs older than `completeJobRetentionMs` (default 24 hours).

You can run as many workers and schedulers as you want, on as many machines as you want. Dequeue is exactly-once among concurrent workers.

## Connection

Pass a Postgres URL (not a Redis URL):

```ts
const connection = {
  connectionString: "postgres://user:pass@host:5432/dbname",
  schema: "pgqueue", // optional; default "pgqueue"
};
```

Or discrete fields, or a pool you already own:

```ts
const connection = {
  host: "127.0.0.1",
  port: 5432,
  database: "myapp", // database *name*, not a Redis logical DB index
  user: "postgres",
  password: "secret",
  ssl: true,
};

// or
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const connection = { pool };
```

`schema` isolates this library's `pgrq_*` tables inside one Postgres database. It defaults to `pgqueue` and must be a legal SQL identifier (`letters`, `numbers`, `_`) that does not begin with PostgreSQL's reserved `pg_` prefix.

Coming from node-resque: replace `{ host, port, password, database: 0 }` / `{ redis }` / `{ namespace: "resque" }` with `{ connectionString }` or `{ pool }` and `{ schema }`.

## Queue, Worker, and Scheduler

- **Queue** — the interface your program uses to enqueue work and inspect the cluster (`enqueue`, `enqueueIn`, `enqueueAt`, `queued`, `failed`, `workers`, …).
- **Worker** — pulls jobs and runs `perform`. If a job throws, it is recorded as failed.
- **Scheduler** — cluster coordinator. Only the leader does work. The delay on `enqueueIn` / `enqueueAt` is when the job becomes *available*, not a guarantee it runs at that instant.

```ts
const worker = new Worker(
  { connection, queues: ["math"], timeout: 5000 },
  jobs,
);

worker.on("start", () => console.log("worker started"));
worker.on("end", () => console.log("worker ended"));
worker.on("poll", (queue) => console.log(`polling ${queue}`));
worker.on("job", (queue, job) => console.log(`working ${queue}`, job));
worker.on("success", (queue, job, result, duration) => {
  console.log(`success ${queue}`, result, `${duration}ms`);
});
worker.on("failure", (queue, job, failure, duration) => {
  console.log(`failure ${queue}`, failure, `${duration}ms`);
});
worker.on("error", (error, queue, job) => console.log("error", error));
worker.on("pause", () => console.log("paused"));
worker.on("ping", (time) => console.log(`check-in @ ${time}`));

await worker.connect();
worker.start();
```

```ts
const scheduler = new Scheduler({
  connection,
  timeout: 5000,
  stuckWorkerTimeout: 60 * 60 * 1000,
  automigrate: true,
  completeJobRetentionMs: 24 * 60 * 60 * 1000,
});

scheduler.on("leader", () => console.log("became leader"));
scheduler.on("poll", () => console.log("scheduler polling"));
scheduler.on("cleanStuckWorker", (workerName, errorPayload, delta) => {
  console.log(`failing stuck worker ${workerName} after ${delta}s`);
});

await scheduler.connect();
scheduler.start();
```

Run **at least one scheduler** in production so schema migrations, delayed jobs, stuck-worker cleanup, and the completed-job sweeper actually run.

Worker names must follow `hostname:pid` or `hostname:pid+unique_id` if you run more than one worker in a process.

### `Worker#performInline`

**Do not use this in production.** For tests, `worker.performInline(jobName, args)` runs a job in-process with no Postgres writes. The worker must not be `start()`ed.

## Scheduler options

| Option | Default | Meaning |
| --- | --- | --- |
| `automigrate` | `true` | Leader applies the bundled versioned SQL migrations. Workers never migrate. |
| `completeJobRetentionMs` | `24 * 60 * 60 * 1000` | Leader deletes **completed** (and cancelled) jobs older than this. Failed jobs are kept until you retry or remove them. `false` disables the sweeper. `0` deletes completed jobs as soon as the leader sees them. |
| `stuckWorkerTimeout` | 1 hour | If a worker has not pinged within this window, fail its in-flight job and remove it. Set `false` to disable. |
| `leaderLockTimeout` | 180 seconds | Leader lock TTL; refreshed while the leader is alive. |
| `timeout` | 5000 ms | Poll interval. |
| `retryStuckJobs` | `false` | After cleaning a stuck worker, re-enqueue jobs that were failed that way. |

If you only enqueue from a process (no scheduler in that process), either run a scheduler elsewhere with `automigrate: true`, or call `connection.migrate()` yourself during deploy.

## Queue management

```ts
const queue = new Queue({ connection }, jobs);
await queue.connect();

await queue.enqueue("math", "add", [1, 2]);
await queue.enqueueAt(Date.now() + 10_000, "math", "add", [3, 4]);
await queue.enqueueIn(5_000, "math", "add", [5, 6]);

await queue.length("math");
await queue.queued("math", 0, 99);
await queue.del("math", "add", [1, 2]);
await queue.delByFunction("math", "add");
await queue.delQueue("math");

await queue.scheduledAt("math", "add", [3, 4]);
await queue.timestamps();
await queue.delayedAt(timestamp);
await queue.allDelayed();
await queue.delDelayed("math", "add", [3, 4]);

await queue.queues();
await queue.workers();
await queue.allWorkingOn();
await queue.stats();
await queue.leader();
```

## Failed jobs

Uncaught exceptions in `perform` move the job to the failed set (payload, stack, worker, timestamp).

```ts
const failedCount = await queue.failedCount();
const failedJobs = await queue.failed(0, -1); // all

await queue.removeFailed(failedJobs[0]);
await queue.retryAndRemoveFailed(failedJobs[0]);
```

A failed payload looks like:

```ts
{
  worker: "host:pid",
  queue: "math",
  payload: { class: "add", queue: "math", args: [1, 2] },
  exception: "Error",
  error: "something broke",
  backtrace: [" at Worker.perform …"],
  failed_at: "…",
}
```

### Stuck workers

Every worker heartbeats on `timeout`. If the process dies without `end()`, the leader fails that worker's job after `stuckWorkerTimeout`.

You can also clean by age or by name:

```ts
await queue.cleanOldWorkers(1000 * 60 * 60);
await queue.forceCleanWorker("hostname:1234");
await queue.retryStuckJobs();
```

## Recurring jobs (CRON)

There is no built-in crontab. Use `node-schedule` / `node-cron` and enqueue **only on the leader** so a cluster does not schedule N copies:

```ts
import schedule from "node-schedule";

schedule.scheduleJob("0 * * * * *", async () => {
  if (scheduler.leader) {
    await queue.enqueue("time", "ticktock", [new Date().toISOString()]);
  }
});
```

## Plugins

Jobs may list plugins that extend `Plugin`. Hooks: `beforeEnqueue`, `afterEnqueue`, `beforePerform`, `afterPerform`. `before*` hooks return `true` to continue or `false` to skip.

```ts
import { Plugin } from "pg-queue";

class MyPlugin extends Plugin {
  async beforeEnqueue() {
    return true;
  }
  async afterEnqueue() {}
  async beforePerform() {
    return true;
  }
  async afterPerform() {}
}

const jobs = {
  add: {
    plugins: [MyPlugin],
    pluginOptions: { MyPlugin: { thing: "stuff" } },
    perform: (a: number, b: number) => a + b,
  },
};
```

Built-ins (`Plugins.*`):

- **JobLock** — if the same job+queue+args is already running, re-enqueue later (or drop)
- **QueueLock** — if the same job+queue+args is already queued, do not enqueue again
- **DelayQueueLock** — if the same job is already delayed, do not enqueue again
- **Retry** — on failure, retry N times before the failed set
- **Noop** — helper for swallowing errors in `afterPerform`

Inspect or delete plugin locks with `queue.locks()` and `queue.delLock(key)`.

## MultiWorker

`MultiWorker` wraps `Worker` and scales the number of in-process workers from `minTaskProcessors` to `maxTaskProcessors` based on event-loop delay (more workers for I/O-bound jobs, fewer when the loop is blocked).

```ts
import { MultiWorker } from "pg-queue";

const multiWorker = new MultiWorker(
  {
    connection,
    queues: ["slowQueue"],
    minTaskProcessors: 1,
    maxTaskProcessors: 100,
    checkTimeout: 1000,
    maxEventLoopDelay: 10,
  },
  jobs,
);

multiWorker.on("success", (workerId, queue, job, result) => {
  console.log(`worker[${workerId}]`, result);
});
multiWorker.on("multiWorkerAction", (verb, delay) => {
  console.log(verb, `event loop delay ${delay}ms`);
});

multiWorker.start();
```

Raise your Postgres pool `max` when using a large `maxTaskProcessors`. Events match `Worker`, with `workerId` as the first argument.

## Requirements

- Node.js 26+ or [Bun](https://bun.sh)
- PostgreSQL 13+ (`SKIP LOCKED`)

```bash
npm install pg-queue
# or
bun add pg-queue
```

## License

Apache-2.0
