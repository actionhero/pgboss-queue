import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import type { QueryResultRow } from "pg";
import type { ErrorPayload } from "../types/errorPayload.js";
import type { Jobs } from "../types/job.js";
import { Connection, type QueueOptions } from "./connection.js";
import { runPlugins } from "./pluginRunner.js";

const QUEUED_STATES = ["created", "retry"] as const;
const DUPLICATE_ERROR = "Job already enqueued at this time with same arguments";

/** Payload stored in pg-boss's `job.data` column. */
export interface ParsedJob {
  /** Registered job name. */
  class: string;
  /** Queue name. */
  queue: string;
  /** Positional job arguments. */
  args: unknown[];
  /** Optional per-plugin configuration copied by callers when needed. */
  pluginOptions?: Record<string, Record<string, unknown>>;
}

/** Description of work currently assigned to a worker. */
export interface ParsedWorkerPayload {
  /** Date string for when work started. */
  run_at: string;
  /** Queue being worked. */
  queue: string;
  /** Worker name. */
  worker: string;
  /** Encoded job payload. */
  payload: ParsedJob;
  /** pg-boss job id recorded by the worker, when present. */
  id?: string;
}

/** Failed-job representation returned by Queue inspection methods. */
export interface ParsedFailedJobPayload extends ErrorPayload {
  /** pg-boss job id used for precise removal and retry. */
  id?: string;
}

interface JobRow extends QueryResultRow {
  id: string;
  name: string;
  data: unknown;
  output?: unknown;
  created_on: Date;
  start_after: Date;
  completed_on?: Date | null;
}

interface WorkerRow extends QueryResultRow {
  name: string;
  queues: string;
  working_on: unknown;
}

/**
 * PostgreSQL-backed node-resque Queue API.
 *
 * Queue methods use pg-boss for insertion and its `job` table for compatible
 * inspection and administration.
 */
export class Queue extends EventEmitter {
  /** Resolved Queue options. */
  readonly options: QueueOptions;
  /** Named jobs used by enqueue plugins and, later, Workers. */
  readonly jobs: Jobs;
  /** Underlying PostgreSQL / pg-boss connection. */
  readonly connection: Connection;

  /**
   * @param options - Queue options containing PostgreSQL connection settings.
   * @param jobs - Named job implementations. Functions are accepted as shorthand.
   */
  constructor(options: QueueOptions = {}, jobs: Jobs = {}) {
    super();
    this.options = options;
    this.jobs = jobs;
    this.connection = new Connection(options.connection);
    this.connection.on("error", (error: Error) => this.emit("error", error));
  }

  /** Connect the underlying PostgreSQL and pg-boss clients. */
  async connect(): Promise<void> {
    await this.connection.connect();
  }

  /** Stop the underlying clients and owned pool. */
  async end(): Promise<void> {
    await this.connection.end();
  }

  /**
   * Encode a node-resque job payload.
   *
   * @param q - Queue name.
   * @param func - Registered job name.
   * @param args - Positional arguments.
   * @returns Stable JSON payload.
   */
  encode(q: string, func: string, args: unknown[] = []): string {
    return JSON.stringify({ class: func, queue: q, args });
  }

  /**
   * Enqueue a named job for immediate processing.
   *
   * @param q - Queue name.
   * @param func - Registered job name.
   * @param args - Array or single argument; omitted means no arguments.
   * @returns `false` when a before-enqueue plugin vetoes the job, otherwise `true`.
   */
  async enqueue(q: string, func: string, args: unknown = []): Promise<boolean> {
    const normalizedArgs = arrayify(args);
    const toRun = await runPlugins(
      this,
      "beforeEnqueue",
      func,
      q,
      this.jobs[func],
      normalizedArgs,
    );
    if (!toRun) return false;

    await this.sendJob(q, this.payload(q, func, normalizedArgs));

    await runPlugins(
      this,
      "afterEnqueue",
      func,
      q,
      this.jobs[func],
      normalizedArgs,
    );
    return true;
  }

  /**
   * Schedule a job at a Unix timestamp in milliseconds.
   *
   * Duplicate identity is `(queue, class, args, rounded timestamp second)`.
   * Enqueue plugins intentionally do not run until scheduler transfer semantics.
   *
   * @param timestamp - Unix milliseconds; numeric strings are accepted.
   * @param q - Queue name.
   * @param func - Registered job name.
   * @param args - Array or single argument.
   * @param suppressDuplicateTaskError - Return `undefined` instead of throwing.
   * @returns `true` when inserted, or `undefined` when a duplicate is suppressed.
   * @throws If the timestamp is invalid or the same task is already scheduled.
   */
  async enqueueAt(
    timestamp: number | string,
    q: string,
    func: string,
    args: unknown = [],
    suppressDuplicateTaskError = false,
  ): Promise<true | undefined> {
    const normalizedArgs = arrayify(args);
    const timestampMs = parseFiniteNumber(timestamp, "timestamp");
    const second = Math.round(timestampMs / 1000);
    const startAfter = new Date(second * 1000);
    const payload = this.payload(q, func, normalizedArgs);
    const duplicateKey = delayedLockKey(
      this.encode(q, func, normalizedArgs),
      second,
    );

    const acquired = await this.acquireDelayedLock(duplicateKey, startAfter);
    if (!acquired) {
      if (suppressDuplicateTaskError) return undefined;
      throw new Error(DUPLICATE_ERROR);
    }

    try {
      await this.sendJob(q, payload, { startAfter });
    } catch (error) {
      await this.connection.delLock(duplicateKey);
      throw error;
    }

    return true;
  }

  /**
   * Schedule a job after a delay.
   *
   * @param time - Delay in milliseconds; numeric strings are accepted.
   * @param q - Queue name.
   * @param func - Registered job name.
   * @param args - Array or single argument.
   * @param suppressDuplicateTaskError - Suppress duplicate-task errors.
   * @returns Result from {@link enqueueAt}.
   */
  async enqueueIn(
    time: number | string,
    q: string,
    func: string,
    args: unknown = [],
    suppressDuplicateTaskError = false,
  ): Promise<true | undefined> {
    return this.enqueueAt(
      Date.now() + parseFiniteNumber(time, "time"),
      q,
      func,
      args,
      suppressDuplicateTaskError,
    );
  }

  /** @returns All known pg-boss queue names and queue names present in jobs. */
  async queues(): Promise<string[]> {
    const [configured, jobs] = await Promise.all([
      this.connection.boss.getQueues(),
      this.connection.query<{ name: string }>(
        `SELECT DISTINCT name FROM ${this.connection.schema}.job`,
      ),
    ]);
    return Array.from(
      new Set([
        ...configured.map((queue) => queue.name),
        ...jobs.rows.map((row) => row.name),
      ]),
    ).sort();
  }

  /**
   * Delete a queue and all non-active jobs in it.
   *
   * @param q - Queue name.
   * @returns Number of jobs deleted.
   */
  async delQueue(q: string): Promise<number> {
    const schema = this.connection.schema;
    const client = await this.connection.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT name FROM ${schema}.queue WHERE name = $1 FOR UPDATE`,
        [q],
      );
      const result = await client.query<{
        data: unknown;
        start_after: Date;
      }>(
        `DELETE FROM ${schema}.job
         WHERE name = $1 AND state <> 'active'
         RETURNING data, start_after`,
        [q],
      );
      const remaining = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM ${schema}.job WHERE name = $1
         ) AS exists`,
        [q],
      );
      if (!remaining.rows[0]?.exists && (locked.rowCount ?? 0) > 0) {
        await client.query(`SELECT ${schema}.delete_queue($1)`, [q]);
      }
      await client.query("COMMIT");

      await Promise.all(
        result.rows
          .filter((row) => new Date(row.start_after).getTime() > Date.now())
          .map((row) => {
            const payload = parseJob(row.data, q);
            const second = Math.round(
              new Date(row.start_after).getTime() / 1000,
            );
            return this.connection.delLock(
              delayedLockKey(
                this.encode(payload.queue, payload.class, payload.args),
                second,
              ),
            );
          }),
      );
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // Transaction may already be closed.
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Count ready jobs in a queue. Delayed jobs are excluded.
   *
   * @param q - Queue name.
   * @returns Number of ready jobs.
   */
  async length(q: string): Promise<number> {
    const result = await this.connection.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${this.connection.schema}.job
       WHERE name = $1
         AND state = ANY($2::${this.connection.schema}.job_state[])
         AND start_after <= now()`,
      [q, QUEUED_STATES],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * List ready jobs using Redis `LRANGE`-style inclusive indices.
   *
   * @param q - Queue name.
   * @param start - Zero-based start index.
   * @param stop - Inclusive stop index; `-1` means the end.
   * @returns Encoded job payloads in FIFO order.
   */
  async queued(q: string, start = 0, stop = -1): Promise<ParsedJob[]> {
    const range = sqlRange(start, stop);
    const result = await this.connection.query<JobRow>(
      `SELECT id, name, data, created_on, start_after
       FROM ${this.connection.schema}.job
       WHERE name = $1
         AND state = ANY($2::${this.connection.schema}.job_state[])
         AND start_after <= now()
       ORDER BY created_on, id
       OFFSET $3
       ${range.limitSql}`,
      [q, QUEUED_STATES, range.offset, ...range.values],
    );
    return result.rows.map((row) => parseJob(row.data, row.name));
  }

  /**
   * Delete ready jobs matching class and arguments.
   *
   * @param q - Queue name.
   * @param func - Registered job name.
   * @param args - Array or single argument.
   * @param count - `0` deletes all; positive deletes from the front; negative from the end.
   * @returns Number of jobs deleted.
   */
  async del(
    q: string,
    func: string,
    args: unknown = [],
    count = 0,
  ): Promise<number> {
    const payload = JSON.stringify(this.payload(q, func, arrayify(args)));
    const direction = count < 0 ? "DESC" : "ASC";
    const limitSql = count === 0 ? "" : "LIMIT $3";
    const values: unknown[] = [q, payload];
    if (count !== 0) values.push(Math.abs(count));

    const result = await this.connection.query(
      `WITH selected AS (
         SELECT id
         FROM ${this.connection.schema}.job
         WHERE name = $1
           AND state = ANY(ARRAY['created','retry']::${this.connection.schema}.job_state[])
           AND start_after <= now()
           AND data = $2::jsonb
         ORDER BY created_on ${direction}, id ${direction}
         ${limitSql}
       )
       DELETE FROM ${this.connection.schema}.job
       WHERE id IN (SELECT id FROM selected)`,
      values,
    );
    return result.rowCount ?? 0;
  }

  /**
   * Delete ready jobs of one class within an inclusive queue slice.
   *
   * @param q - Queue name.
   * @param func - Job class/name to remove.
   * @param start - Zero-based slice start.
   * @param stop - Inclusive slice end; `-1` means the end.
   * @returns Number of jobs deleted.
   */
  async delByFunction(
    q: string,
    func: string,
    start = 0,
    stop = -1,
  ): Promise<number> {
    const range = sqlRange(start, stop);
    const result = await this.connection.query(
      `WITH sliced AS (
         SELECT id, data
         FROM ${this.connection.schema}.job
         WHERE name = $1
           AND state = ANY(ARRAY['created','retry']::${this.connection.schema}.job_state[])
           AND start_after <= now()
         ORDER BY created_on, id
         OFFSET $3
         ${range.limitSql}
       )
       DELETE FROM ${this.connection.schema}.job
       WHERE id IN (
         SELECT id FROM sliced WHERE data->>'class' = $2
       )`,
      [q, func, range.offset, ...range.values],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Delete all delayed jobs matching a payload.
   *
   * @param q - Queue name.
   * @param func - Registered job name.
   * @param args - Array or single argument.
   * @returns Rounded Unix timestamps in seconds for deleted jobs.
   */
  async delDelayed(
    q: string,
    func: string,
    args: unknown = [],
  ): Promise<number[]> {
    const encoded = this.encode(q, func, arrayify(args));
    const result = await this.connection.query<{ start_after: Date }>(
      `DELETE FROM ${this.connection.schema}.job
       WHERE name = $1
         AND state = ANY(ARRAY['created','retry']::${this.connection.schema}.job_state[])
         AND start_after > now()
         AND data = $2::jsonb
       RETURNING start_after`,
      [q, encoded],
    );
    const seconds = result.rows.map((row) =>
      Math.round(new Date(row.start_after).getTime() / 1000),
    );
    await Promise.all(
      seconds.map((second) =>
        this.connection.delLock(delayedLockKey(encoded, second)),
      ),
    );
    return seconds;
  }

  /**
   * Find times at which a matching job is delayed.
   *
   * @param q - Queue name.
   * @param func - Registered job name.
   * @param args - Array or single argument.
   * @returns Rounded Unix timestamps in seconds.
   */
  async scheduledAt(
    q: string,
    func: string,
    args: unknown = [],
  ): Promise<number[]> {
    const result = await this.connection.query<{ start_after: Date }>(
      `SELECT start_after
       FROM ${this.connection.schema}.job
       WHERE name = $1
         AND state = ANY(ARRAY['created','retry']::${this.connection.schema}.job_state[])
         AND start_after > now()
         AND data = $2::jsonb
       ORDER BY start_after, created_on, id`,
      [q, this.encode(q, func, arrayify(args))],
    );
    return result.rows.map((row) =>
      Math.round(new Date(row.start_after).getTime() / 1000),
    );
  }

  /** @returns Distinct delayed timestamps in milliseconds, sorted ascending. */
  async timestamps(): Promise<number[]> {
    const result = await this.connection.query<{ start_after: Date }>(
      `SELECT DISTINCT start_after
       FROM ${this.connection.schema}.job
       WHERE state = ANY(ARRAY['created','retry']::${this.connection.schema}.job_state[])
         AND start_after > now()
       ORDER BY start_after`,
    );
    return result.rows.map(
      (row) => Math.round(new Date(row.start_after).getTime() / 1000) * 1000,
    );
  }

  /**
   * List jobs delayed at one rounded timestamp second.
   *
   * @param timestamp - Unix milliseconds; numeric strings are accepted.
   * @returns Tasks and rounded Unix timestamp in seconds.
   */
  async delayedAt(
    timestamp: number | string,
  ): Promise<{ tasks: ParsedJob[]; rTimestamp: number }> {
    const rTimestamp = Math.round(
      parseFiniteNumber(timestamp, "timestamp") / 1000,
    );
    const result = await this.connection.query<JobRow>(
      `SELECT id, name, data, created_on, start_after
       FROM ${this.connection.schema}.job
       WHERE state = ANY(ARRAY['created','retry']::${this.connection.schema}.job_state[])
         AND start_after > now()
         AND start_after >= to_timestamp($1)
         AND start_after < to_timestamp($1) + interval '1 second'
       ORDER BY created_on, id`,
      [rTimestamp],
    );
    return {
      tasks: result.rows.map((row) => parseJob(row.data, row.name)),
      rTimestamp,
    };
  }

  /**
   * Load all delayed jobs grouped by timestamp milliseconds.
   *
   * This can be expensive for a large delayed queue.
   *
   * @returns Timestamp-to-task-list mapping.
   */
  async allDelayed(): Promise<Record<string, ParsedJob[]>> {
    const result: Record<string, ParsedJob[]> = {};
    for (const timestamp of await this.timestamps()) {
      const { tasks, rTimestamp } = await this.delayedAt(timestamp);
      result[String(rTimestamp * 1000)] = tasks;
    }
    return result;
  }

  /** @returns Non-expired plugin lock values keyed by lock name. */
  async locks(): Promise<Record<string, string | null>> {
    await this.connection.query(
      `DELETE FROM ${this.connection.schema}.pgrq_locks
       WHERE expires_at < now()`,
    );
    const result = await this.connection.query<{
      key: string;
      value: string | null;
    }>(
      `SELECT key, value
       FROM ${this.connection.schema}.pgrq_locks
       WHERE key LIKE 'lock:%' OR key LIKE 'workerslock:%'
       ORDER BY key`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
  }

  /**
   * Delete a plugin lock.
   *
   * @param key - Lock key without a schema prefix.
   * @returns Number of rows deleted.
   */
  async delLock(key: string): Promise<number> {
    return this.connection.delLock(key);
  }

  /** @returns Registered workers mapped to their queue string. */
  async workers(): Promise<Record<string, string>> {
    const result = await this.connection.query<WorkerRow>(
      `SELECT name, queues, working_on
       FROM ${this.connection.schema}.pgrq_workers
       ORDER BY name`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.name, row.queues]));
  }

  /**
   * Read one worker's current assignment as JSON.
   *
   * @param workerName - Worker name.
   * @param queues - Expected queue string; mismatches return `null`.
   * @returns JSON payload or `null` when idle/missing.
   */
  async workingOn(workerName: string, queues: string): Promise<string | null> {
    const result = await this.connection.query<{ working_on: unknown }>(
      `SELECT working_on
       FROM ${this.connection.schema}.pgrq_workers
       WHERE name = $1 AND queues = $2`,
      [workerName, queues],
    );
    const value = result.rows[0]?.working_on;
    return value == null ? null : JSON.stringify(value);
  }

  /** @returns Every worker mapped to `"started"` or its active payload. */
  async allWorkingOn(): Promise<
    Record<string, "started" | ParsedWorkerPayload>
  > {
    const result = await this.connection.query<WorkerRow>(
      `SELECT name, queues, working_on
       FROM ${this.connection.schema}.pgrq_workers
       ORDER BY name`,
    );
    const workers: Record<string, "started" | ParsedWorkerPayload> = {};
    for (const row of result.rows) {
      workers[row.name] =
        row.working_on == null
          ? "started"
          : parseWorkerPayload(row.working_on, row.name);
    }
    return workers;
  }

  /**
   * Remove a worker and convert any active assignment into a failed job.
   *
   * @param workerName - Worker to clean.
   * @returns Failure payload when work was active, otherwise `undefined`.
   */
  async forceCleanWorker(
    workerName: string,
  ): Promise<ErrorPayload | undefined> {
    const result = await this.connection.query<WorkerRow>(
      `DELETE FROM ${this.connection.schema}.pgrq_workers
       WHERE name = $1
       RETURNING name, queues, working_on`,
      [workerName],
    );
    const row = result.rows[0];
    if (!row) {
      this.emit(
        "error",
        new Error(
          `force-cleaning worker ${workerName}, but cannot find queues`,
        ),
      );
      return undefined;
    }
    if (row.working_on == null) return undefined;

    const working = parseWorkerPayload(row.working_on, workerName);
    const message = "Worker Timeout (killed manually)";
    const errorPayload: ErrorPayload = {
      worker: workerName,
      queue: working.queue,
      payload: working.payload,
      exception: message,
      error: message,
      backtrace: [
        `killed by ${hostname()} at ${new Date()}`,
        "queue#forceCleanWorker",
        "node-resque",
      ],
      failed_at: new Date().toString(),
    };

    await this.failActiveJob(working, errorPayload);
    await this.connection.incrStat("failed");
    return errorPayload;
  }

  /**
   * Mark the worker's in-flight pg-boss job failed in place.
   *
   * @param working - Worker assignment, including optional job id.
   * @param errorPayload - Resque failure payload stored in `output`.
   */
  private async failActiveJob(
    working: ParsedWorkerPayload,
    errorPayload: ErrorPayload,
  ): Promise<void> {
    const schema = this.connection.schema;
    const updated = await this.connection.query(
      `WITH selected AS (
         SELECT name, id
         FROM ${schema}.job
         WHERE name = $1
           AND state = 'active'
           AND (
             ($4::uuid IS NOT NULL AND id = $4)
             OR ($4::uuid IS NULL AND data = $2::jsonb)
           )
         ORDER BY started_on NULLS FIRST, created_on, id
         LIMIT 1
         FOR UPDATE
       )
       UPDATE ${schema}.job AS job
       SET state = 'failed',
           completed_on = now(),
           output = $3::jsonb
       FROM selected
       WHERE job.name = selected.name AND job.id = selected.id`,
      [
        working.queue,
        JSON.stringify(working.payload),
        JSON.stringify(errorPayload),
        working.id ?? null,
      ],
    );
    if ((updated.rowCount ?? 0) > 0) return;
    if (working.id) return;

    await this.ensureQueue(working.queue);
    await this.connection.query(
      `INSERT INTO ${this.connection.schema}.job
         (name, data, state, retry_limit, completed_on, output)
       VALUES ($1, $2::jsonb, 'failed', 0, now(), $3::jsonb)`,
      [
        working.queue,
        JSON.stringify(working.payload),
        JSON.stringify(errorPayload),
      ],
    );
  }

  /**
   * Force-clean workers whose active payload predates an age limit.
   *
   * @param age - Maximum active age in milliseconds.
   * @returns Cleaned failures keyed by worker name.
   */
  async cleanOldWorkers(age: number): Promise<Record<string, ErrorPayload>> {
    const result: Record<string, ErrorPayload> = {};
    const workers = await this.allWorkingOn();
    for (const [workerName, payload] of Object.entries(workers)) {
      if (
        payload !== "started" &&
        Date.now() - Date.parse(payload.run_at) > age
      ) {
        const failure = await this.forceCleanWorker(workerName);
        if (failure) result[workerName] = failure;
      }
    }
    return result;
  }

  /** @returns Number of failed pg-boss jobs. */
  async failedCount(): Promise<number> {
    const result = await this.connection.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${this.connection.schema}.job
       WHERE state = 'failed'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * List failed jobs using inclusive Redis list indices.
   *
   * @param start - Zero-based start index.
   * @param stop - Inclusive stop index; `-1` means all remaining jobs.
   * @returns Resque-compatible failure payloads.
   */
  async failed(start = 0, stop = -1): Promise<ParsedFailedJobPayload[]> {
    const range = sqlRange(start, stop, "$2");
    const result = await this.connection.query<JobRow>(
      `SELECT id, name, data, output, created_on, start_after, completed_on
       FROM ${this.connection.schema}.job
       WHERE state = 'failed'
       ORDER BY completed_on, created_on, id
       OFFSET $1
       ${range.limitSql}`,
      [range.offset, ...range.values],
    );
    return result.rows.map(mapFailedRow);
  }

  /**
   * Remove one failed job when its current payload matches.
   *
   * @param failedJob - Failure object previously returned by {@link failed}.
   * @returns Number removed (`0` or `1`).
   */
  async removeFailed(failedJob: ErrorPayload): Promise<number> {
    const candidates = failedJob.id
      ? await this.connection.query<JobRow>(
          `SELECT id, name, data, output, created_on, start_after, completed_on
           FROM ${this.connection.schema}.job
           WHERE id = $1 AND state = 'failed'`,
          [failedJob.id],
        )
      : await this.connection.query<JobRow>(
          `SELECT id, name, data, output, created_on, start_after, completed_on
           FROM ${this.connection.schema}.job
           WHERE state = 'failed'
           ORDER BY completed_on, created_on, id`,
        );

    const match = candidates.rows.find((row) =>
      sameFailure(mapFailedRow(row), failedJob),
    );
    if (!match) return 0;

    const deleted = await this.connection.query(
      `DELETE FROM ${this.connection.schema}.job
       WHERE id = $1 AND state = 'failed'`,
      [match.id],
    );
    return deleted.rowCount ?? 0;
  }

  /**
   * Remove a failed job and enqueue its original payload.
   *
   * @param failedJob - Failure object previously returned by {@link failed}.
   * @returns Enqueue result.
   * @throws If the failure no longer exists.
   */
  async retryAndRemoveFailed(failedJob: ErrorPayload): Promise<boolean> {
    if ((await this.removeFailed(failedJob)) < 1) {
      throw new Error("This job is not in failed queue");
    }
    return this.enqueue(
      failedJob.queue,
      failedJob.payload.class,
      failedJob.payload.args,
    );
  }

  /**
   * Retry failures created by {@link forceCleanWorker}.
   *
   * @param upperLimit - Maximum number of failed jobs to inspect.
   */
  async retryStuckJobs(upperLimit = Infinity): Promise<void> {
    const limit = Number.isFinite(upperLimit)
      ? Math.max(0, Math.floor(upperLimit))
      : Number.MAX_SAFE_INTEGER;
    if (limit === 0) return;
    const jobs = await this.failed(0, limit - 1);
    for (const job of jobs) {
      if (job.backtrace.includes("queue#forceCleanWorker")) {
        await this.retryAndRemoveFailed(job);
      }
    }
  }

  /** @returns Current non-expired scheduler leader, or `null`. */
  async leader(): Promise<string | null> {
    return this.connection.currentLeader();
  }

  /**
   * Read queue counters using node-resque's string-valued response shape.
   *
   * @returns Named processed/failed counters as decimal strings.
   */
  async stats(): Promise<Record<string, string>> {
    const stats = await this.connection.getStats();
    return Object.fromEntries(
      Object.entries(stats).map(([name, value]) => [name, String(value)]),
    );
  }

  /** @returns Stable metadata slot name used for scheduler leadership. */
  leaderKey(): string {
    return "default";
  }

  private payload(q: string, func: string, args: unknown[]): ParsedJob {
    return { class: func, queue: q, args };
  }

  private async sendJob(
    q: string,
    payload: ParsedJob,
    options: { startAfter?: Date } = {},
  ): Promise<string> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.ensureQueue(q);
      try {
        const id = await this.connection.boss.send(q, payload, {
          retryLimit: 0,
          deleteAfterSeconds: 0,
          ...options,
        });
        if (!id) {
          throw new Error(
            `pg-boss did not enqueue job "${payload.class}" on queue "${q}"`,
          );
        }
        return id;
      } catch (error) {
        lastError = toError(error);
        if (attempt === 0 && isMissingQueue(lastError, q)) continue;
        throw lastError;
      }
    }
    throw lastError ?? new Error(`pg-boss did not enqueue job on queue "${q}"`);
  }

  private async ensureQueue(q: string): Promise<void> {
    const existing = await this.connection.boss.getQueue(q);
    if (existing) return;
    try {
      await this.connection.boss.createQueue(q, {
        retryLimit: 0,
        deleteAfterSeconds: 0,
      });
    } catch (error) {
      if (!(await this.connection.boss.getQueue(q))) throw error;
    }
  }

  private async acquireDelayedLock(
    key: string,
    startAfter: Date,
  ): Promise<boolean> {
    const expiresAt = new Date(
      Math.max(startAfter.getTime() + 1000, Date.now() + 1000),
    );
    const result = await this.connection.query<{ key: string }>(
      `INSERT INTO ${this.connection.schema}.pgrq_locks (key, value, expires_at)
       VALUES ($1, NULL, $2)
       ON CONFLICT (key) DO UPDATE
         SET expires_at = EXCLUDED.expires_at
         WHERE ${this.connection.schema}.pgrq_locks.expires_at < now()
       RETURNING key`,
      [key, expiresAt],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function arrayify(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function parseFiniteNumber(value: number | string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function delayedLockKey(encoded: string, second: number): string {
  const digest = createHash("sha256")
    .update(stableJson(JSON.parse(encoded)))
    .digest("hex");
  return `timestamps:${digest}:delayed:${second}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortUnknown(value));
}

function sortUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortUnknown);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortUnknown(value[key])]),
    );
  }
  return value;
}

function parseJob(value: unknown, fallbackQueue: string): ParsedJob {
  if (!isRecord(value)) {
    throw new Error("Stored job payload is not an object");
  }
  const func = value.class;
  const queue = value.queue;
  const args = value.args;
  if (typeof func !== "string" || !Array.isArray(args)) {
    throw new Error("Stored job payload is invalid");
  }
  return {
    class: func,
    queue: typeof queue === "string" ? queue : fallbackQueue,
    args,
  };
}

function parseWorkerPayload(
  value: unknown,
  fallbackWorker: string,
): ParsedWorkerPayload {
  if (!isRecord(value)) throw new Error("Stored worker payload is invalid");
  const payload = parseJob(value.payload, String(value.queue ?? ""));
  return {
    run_at: String(value.run_at ?? ""),
    queue: typeof value.queue === "string" ? value.queue : payload.queue,
    worker: typeof value.worker === "string" ? value.worker : fallbackWorker,
    payload,
    id: typeof value.id === "string" ? value.id : undefined,
  };
}

function mapFailedRow(row: JobRow): ParsedFailedJobPayload {
  const payload = parseJob(row.data, row.name);
  const output = isRecord(row.output) ? row.output : {};
  const nested = isRecord(output.error) ? output.error : output;
  const stack = typeof nested.stack === "string" ? nested.stack : undefined;
  const backtrace = Array.isArray(output.backtrace)
    ? output.backtrace.map(String)
    : (stack?.split("\n").slice(1) ?? []);
  const completed = row.completed_on ? new Date(row.completed_on) : new Date();

  return {
    id: row.id,
    worker: typeof output.worker === "string" ? output.worker : "",
    queue: typeof output.queue === "string" ? output.queue : payload.queue,
    payload,
    exception:
      typeof output.exception === "string"
        ? output.exception
        : typeof nested.name === "string"
          ? nested.name
          : "Error",
    error:
      typeof output.error === "string"
        ? output.error
        : typeof nested.message === "string"
          ? nested.message
          : String(row.output ?? "Error"),
    backtrace,
    failed_at:
      typeof output.failed_at === "string"
        ? output.failed_at
        : completed.toString(),
  };
}

function sameFailure(
  left: ParsedFailedJobPayload,
  right: ErrorPayload,
): boolean {
  return (
    left.worker === right.worker &&
    left.queue === right.queue &&
    left.exception === right.exception &&
    left.error === right.error &&
    left.failed_at === right.failed_at &&
    JSON.stringify(left.payload) === JSON.stringify(right.payload) &&
    JSON.stringify(left.backtrace) === JSON.stringify(right.backtrace)
  );
}

function sqlRange(
  start: number,
  stop: number,
  limitPlaceholder = "$4",
): { offset: number; limitSql: string; values: number[] } {
  const offset = Math.max(0, Math.floor(start));
  if (stop < 0) return { offset, limitSql: "", values: [] };
  const limit = Math.max(0, Math.floor(stop) - offset + 1);
  return { offset, limitSql: `LIMIT ${limitPlaceholder}`, values: [limit] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingQueue(error: Error, q: string): boolean {
  return error.message.includes(`Queue ${q} does not exist`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
