import { EventEmitter } from "node:events";
import {
  Pool,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { PgBoss } from "pg-boss";

const DEFAULT_SCHEMA = "pgboss_queue";
const DEFAULT_APPLICATION_NAME = "pgboss-queue";
const SCHEMA_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LEADER_SLOT = "default";

/**
 * Postgres connection options for pgboss-queue.
 *
 * Maps from node-resque Redis options as follows:
 * - `{ host, port, password, database: 0 }` → `{ connectionString }` or
 *   `{ host, port, user, password, database: "myapp" }`
 * - `{ redis: ioredis }` → `{ pool: pg.Pool }`
 * - `{ namespace: "resque" }` → `{ schema: "resque" }` (legal SQL identifier only)
 * - `{ namespace: ["a","b"] }` → not supported; use one schema name
 *
 * Do not pass Redis-only options (`pkg`, `redis`, or a numeric `database`).
 */
export interface ConnectionOptions {
  /** postgres:// URL. Preferred. Parsed by `pg`. */
  connectionString?: string;
  /** Postgres host. Default `127.0.0.1`. */
  host?: string;
  /** Postgres port. Default `5432`. */
  port?: number;
  /** Database *name* (string), not a Redis logical DB index. */
  database?: string;
  /** Postgres user. */
  user?: string;
  /** Postgres password. */
  password?: string;
  /** TLS flag or `pg` SSL options object. */
  ssl?: boolean | object;
  /**
   * Existing node-postgres Pool. When set, we do not create or end a pool.
   * Analogous to passing `redis: ioredisInstance`.
   */
  pool?: Pool;
  /**
   * pg-boss schema AND our metadata schema. Default `pgboss_queue`.
   * Must match `^[a-zA-Z_][a-zA-Z0-9_]*$` (reject otherwise).
   */
  schema?: string;
  /** Reported to Postgres as `application_name`. Default `pgboss-queue`. */
  application_name?: string;
}

/**
 * Options shared by Queue / Worker / Scheduler constructors
 * (`{ connection: ConnectionOptions, ... }`).
 */
export interface QueueOptions {
  connection?: ConnectionOptions;
  /** Optional default queue retained for node-resque constructor compatibility. */
  queue?: string | string[];
}

/**
 * Worker constructor options (Phase 4). Defined here for a stable options surface.
 */
export interface WorkerOptions extends QueueOptions {
  name?: string;
  queues?: string[] | string;
  timeout?: number;
  looping?: boolean;
  id?: number;
}

/**
 * Scheduler constructor options (Phase 5). Defined here for a stable options surface.
 */
export interface SchedulerOptions extends QueueOptions {
  name?: string;
  timeout?: number;
  /** Leader lock TTL in seconds. Default `180`. */
  leaderLockTimeout?: number;
  stuckWorkerTimeout?: number | false;
  retryStuckJobs?: boolean;
  /** Leader runs pg-boss migrate + metadata DDL. Default `true`. */
  automigrate?: boolean;
  /**
   * Leader deletes completed/cancelled jobs older than this. Default 24h.
   * `false` disables.
   */
  completeJobRetentionMs?: number | false;
}

/**
 * MultiWorker constructor options (Phase 7). Defined here for a stable options surface.
 */
export interface MultiWorkerOptions extends WorkerOptions {
  minTaskProcessors?: number;
  maxTaskProcessors?: number;
  checkTimeout?: number;
  maxEventLoopDelay?: number;
}

/**
 * Postgres + pg-boss connection used by Queue, Worker, and Scheduler.
 *
 * Call {@link Connection.migrate} (via the elected scheduler, or explicitly in
 * tests/deploy) before workers expect a usable schema. Instances constructed for
 * workers/queues always use `migrate: false`, `supervise: false`, and
 * `schedule: false` on pg-boss.
 */
export class Connection extends EventEmitter {
  /** Resolved connection options (defaults applied). */
  options: ConnectionOptions;
  /** Whether {@link Connection.connect} succeeded (pool ready). */
  connected: boolean;

  private eventListeners: {
    poolError?: (error: Error) => void;
    bossError?: (error: Error) => void;
  } = {};

  private _pool: Pool | undefined;
  private _boss: PgBoss | undefined;
  private _schema: string;
  private ownsPool = false;
  private bossStarted = false;

  /**
   * @param options - Postgres connection options. Redis options are rejected.
   * @throws If `schema` is illegal or Redis-only options are present.
   */
  constructor(options: ConnectionOptions = {}) {
    super();
    rejectRedisOptions(options);

    const schema = options.schema ?? DEFAULT_SCHEMA;
    assertSchema(schema);

    this.options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 5432,
      application_name: options.application_name ?? DEFAULT_APPLICATION_NAME,
      schema,
      connectionString: options.connectionString,
      database: options.database,
      user: options.user,
      password: options.password,
      ssl: options.ssl,
      pool: options.pool,
    };
    this._schema = schema;
    this.connected = false;
  }

  /** Validated pg-boss / metadata schema name. */
  get schema(): string {
    return this._schema;
  }

  /**
   * Underlying `pg` pool. Available after {@link Connection.connect}.
   * @throws If not connected.
   */
  get pool(): Pool {
    if (!this._pool) {
      throw new Error("Connection is not connected");
    }
    return this._pool;
  }

  /**
   * pg-boss client started with `migrate`/`supervise`/`schedule` disabled.
   * @throws If not connected.
   */
  get boss(): PgBoss {
    if (!this._boss) {
      throw new Error("Connection is not connected");
    }
    return this._boss;
  }

  /**
   * Open the pool (unless `pool` was provided), construct pg-boss, and start it
   * when the schema is already installed. If pg-boss is not installed yet,
   * the pool stays usable so {@link Connection.migrate} can run.
   *
   * @throws On connection failure (emits `error` as well).
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      await this.ensurePoolAndBoss();
      await this.tryStartBoss();
      this.connected = true;
    } catch (error) {
      const err = toError(error);
      this.emit("error", err);
      await this.teardownPartialConnect();
      throw err;
    }
  }

  /**
   * Stop pg-boss and, if we created the pool, end it. Provided pools are left open.
   * Removes forwarded `error` listeners from the pool and boss.
   */
  async end(): Promise<void> {
    this.removeForwardedListeners();

    if (this._boss && this.bossStarted) {
      await this._boss.stop({ graceful: true, close: false });
      this.bossStarted = false;
    }

    if (this.ownsPool && this._pool) {
      await this._pool.end();
    }

    this._boss = undefined;
    this._pool = undefined;
    this.ownsPool = false;
    this.connected = false;
  }

  /**
   * Build a lock / metadata key string (no schema prefix).
   * Empty / whitespace-only parts are dropped.
   *
   * @param parts - Key segments (e.g. `lock`, function, queue, args).
   * @returns Colon-joined key suitable for `pgrq_locks.key`.
   */
  key(...parts: Array<string | number | boolean | null | undefined>): string {
    return parts
      .map((part) => String(part ?? ""))
      .filter((part) => part.trim().length > 0)
      .join(":");
  }

  /**
   * Run a parameterized query on the connection pool.
   * Schema names must already be validated identifiers when interpolated by callers.
   *
   * @param text - SQL text with `$1`-style placeholders.
   * @param values - Bound parameter values.
   * @returns pg query result.
   * @throws If not connected.
   */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values);
  }

  /**
   * Idempotently install the schema: `CREATE SCHEMA`, pg-boss migrate, and
   * `pgrq_*` metadata tables/indexes. Intended for the scheduler leader (or tests).
   *
   * @throws If the pool cannot be opened or migration SQL fails.
   */
  async migrate(): Promise<void> {
    if (!this._pool || !this._boss) {
      await this.ensurePoolAndBoss();
      this.connected = true;
    }

    const schema = this._schema;
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

    const migrator = new PgBoss({
      db: this.dbAdapter(),
      schema,
      migrate: true,
      supervise: false,
      schedule: false,
      application_name: this.options.application_name,
    });

    await migrator.start();
    await migrator.stop({ graceful: true, close: false });

    await this.applyMetadataDdl();

    if (!this.bossStarted) {
      await this.boss.start();
      this.bossStarted = true;
    }
  }

  /**
   * Set a lock only if absent (or expired). Redis `SET NX EX` analogue.
   *
   * @param key - Lock key.
   * @param value - Lock owner / payload string.
   * @param ttlSeconds - Time-to-live in seconds.
   * @returns `true` if this caller acquired the lock.
   */
  async setLockNx(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const schema = this._schema;
    const result = await this.query<{ key: string }>(
      `INSERT INTO ${schema}.pgrq_locks (key, value, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             expires_at = EXCLUDED.expires_at
         WHERE ${schema}.pgrq_locks.expires_at < now()
       RETURNING key`,
      [key, value, ttlSeconds],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Read a non-expired lock value. Expired rows are deleted and treated as absent.
   *
   * @param key - Lock key.
   * @returns Lock value, or `null` if missing/expired.
   */
  async getLock(key: string): Promise<string | null> {
    const schema = this._schema;
    await this.query(
      `DELETE FROM ${schema}.pgrq_locks WHERE key = $1 AND expires_at < now()`,
      [key],
    );
    const result = await this.query<{ value: string | null }>(
      `SELECT value FROM ${schema}.pgrq_locks
       WHERE key = $1 AND expires_at >= now()`,
      [key],
    );
    return result.rows[0]?.value ?? null;
  }

  /**
   * Delete a lock row.
   *
   * @param key - Lock key.
   * @returns Number of rows deleted (`0` or `1`).
   */
  async delLock(key: string): Promise<number> {
    const result = await this.query(
      `DELETE FROM ${this._schema}.pgrq_locks WHERE key = $1`,
      [key],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Refresh a lock's TTL (even if already expired, as long as the row exists).
   *
   * @param key - Lock key.
   * @param ttlSeconds - New TTL from now, in seconds.
   */
  async expireLock(key: string, ttlSeconds: number): Promise<void> {
    await this.query(
      `UPDATE ${this._schema}.pgrq_locks
       SET expires_at = now() + make_interval(secs => $2::double precision)
       WHERE key = $1`,
      [key, ttlSeconds],
    );
  }

  /**
   * Increment a named counter in `pgrq_stats`.
   *
   * @param name - Stat name.
   * @param by - Amount to add. Default `1`.
   */
  async incrStat(name: string, by = 1): Promise<void> {
    await this.query(
      `INSERT INTO ${this._schema}.pgrq_stats (name, value)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE
         SET value = ${this._schema}.pgrq_stats.value + EXCLUDED.value`,
      [name, by],
    );
  }

  /**
   * Decrement a named counter in `pgrq_stats`.
   *
   * @param name - Stat name.
   * @param by - Amount to subtract. Default `1`.
   */
  async decrStat(name: string, by = 1): Promise<void> {
    await this.incrStat(name, -by);
  }

  /**
   * Read all stats as a name → value map.
   *
   * @returns Record of counters (missing names are absent, not zero).
   */
  async getStats(): Promise<Record<string, number>> {
    const result = await this.query<{ name: string; value: string }>(
      `SELECT name, value FROM ${this._schema}.pgrq_stats`,
    );
    const stats: Record<string, number> = {};
    for (const row of result.rows) {
      stats[row.name] = Number(row.value);
    }
    return stats;
  }

  /**
   * Try to become (or refresh) the cluster leader for the default slot.
   * Redis `SET NX EX` + refresh-if-mine pattern.
   *
   * @param name - Candidate leader name (e.g. `hostname:pid`).
   * @param ttlSeconds - Leadership TTL in seconds.
   * @returns `true` if this `name` holds leadership after the call.
   */
  async tryLeader(name: string, ttlSeconds: number): Promise<boolean> {
    const schema = this._schema;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ name: string }>(
        `INSERT INTO ${schema}.pgrq_leader (slot, name, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
         ON CONFLICT (slot) DO UPDATE
           SET name = EXCLUDED.name,
               expires_at = EXCLUDED.expires_at
           WHERE ${schema}.pgrq_leader.expires_at < now()
              OR ${schema}.pgrq_leader.name = EXCLUDED.name
         RETURNING name`,
        [LEADER_SLOT, name, ttlSeconds],
      );
      await client.query("COMMIT");
      return result.rows[0]?.name === name;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Release leadership if currently held by `name`.
   *
   * @param name - Leader name that should release the lock.
   * @returns `true` if a row was deleted.
   */
  async releaseLeader(name: string): Promise<boolean> {
    const result = await this.query(
      `DELETE FROM ${this._schema}.pgrq_leader
       WHERE slot = $1 AND name = $2`,
      [LEADER_SLOT, name],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Current non-expired leader name, if any.
   *
   * @returns Leader name or `null`.
   */
  async currentLeader(): Promise<string | null> {
    const result = await this.query<{ name: string }>(
      `SELECT name FROM ${this._schema}.pgrq_leader
       WHERE slot = $1 AND expires_at >= now()`,
      [LEADER_SLOT],
    );
    return result.rows[0]?.name ?? null;
  }

  private async ensurePoolAndBoss(): Promise<void> {
    if (!this._pool) {
      if (this.options.pool) {
        this._pool = this.options.pool;
        this.ownsPool = false;
      } else {
        this._pool = new Pool(this.buildPoolConfig());
        this.ownsPool = true;
      }
    }

    if (!this._boss) {
      this._boss = new PgBoss({
        db: this.dbAdapter(),
        schema: this._schema,
        migrate: false,
        supervise: false,
        schedule: false,
        application_name: this.options.application_name,
      });
    }

    this.attachForwardedListeners();
  }

  private async tryStartBoss(): Promise<void> {
    if (!this._boss || this.bossStarted) return;

    try {
      await this._boss.start();
      this.bossStarted = true;
    } catch (error) {
      if (isPgBossNotInstalled(error)) {
        return;
      }
      throw error;
    }
  }

  private async applyMetadataDdl(): Promise<void> {
    const schema = this._schema;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.pgrq_leader (
        slot        text PRIMARY KEY DEFAULT 'default',
        name        text NOT NULL,
        expires_at  timestamptz NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${schema}.pgrq_workers (
        name        text PRIMARY KEY,
        queues      text NOT NULL,
        started_at  timestamptz NOT NULL DEFAULT now(),
        ping_at     timestamptz NOT NULL DEFAULT now(),
        working_on  jsonb
      );

      CREATE TABLE IF NOT EXISTS ${schema}.pgrq_locks (
        key         text PRIMARY KEY,
        value       text,
        expires_at  timestamptz NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${schema}.pgrq_stats (
        name        text PRIMARY KEY,
        value       bigint NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS pgrq_workers_ping_at_idx
        ON ${schema}.pgrq_workers (ping_at);

      CREATE INDEX IF NOT EXISTS pgrq_locks_expires_at_idx
        ON ${schema}.pgrq_locks (expires_at);
    `);
  }

  private buildPoolConfig(): PoolConfig {
    const {
      connectionString,
      host,
      port,
      database,
      user,
      password,
      ssl,
      application_name,
    } = this.options;

    if (connectionString) {
      return { connectionString, application_name, ssl };
    }

    return {
      host,
      port,
      database,
      user,
      password,
      ssl,
      application_name,
    };
  }

  private dbAdapter(): {
    executeSql: (
      text: string,
      values?: unknown[],
    ) => Promise<QueryResult<QueryResultRow>>;
  } {
    return {
      executeSql: (text: string, values?: unknown[]) =>
        this.pool.query(text, values),
    };
  }

  private attachForwardedListeners(): void {
    if (!this._pool || !this._boss) return;

    this.removeForwardedListeners();

    this.eventListeners.poolError = (error: Error) => {
      this.emit("error", error);
    };
    this.eventListeners.bossError = (error: Error) => {
      this.emit("error", error);
    };

    this._pool.on("error", this.eventListeners.poolError);
    this._boss.on("error", this.eventListeners.bossError);
  }

  private removeForwardedListeners(): void {
    if (this._pool && this.eventListeners.poolError) {
      this._pool.off("error", this.eventListeners.poolError);
    }
    if (this._boss && this.eventListeners.bossError) {
      this._boss.off("error", this.eventListeners.bossError);
    }
    this.eventListeners = {};
  }

  private async teardownPartialConnect(): Promise<void> {
    this.removeForwardedListeners();
    if (this._boss && this.bossStarted) {
      await this._boss.stop({ graceful: false, close: false }).catch(() => {
        // best-effort cleanup after a failed connect
      });
    }
    if (this.ownsPool && this._pool) {
      await this._pool.end().catch(() => {
        // best-effort cleanup after a failed connect
      });
    }
    this._boss = undefined;
    this._pool = undefined;
    this.ownsPool = false;
    this.bossStarted = false;
    this.connected = false;
  }
}

/**
 * @param schema - Candidate schema identifier.
 * @throws If `schema` is not a bare SQL identifier.
 */
export function assertSchema(schema: string): void {
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Invalid schema "${schema}": must match ${SCHEMA_PATTERN}`);
  }
}

function rejectRedisOptions(options: ConnectionOptions): void {
  const raw = options as ConnectionOptions & {
    pkg?: unknown;
    redis?: unknown;
    database?: unknown;
  };

  if (raw.pkg !== undefined) {
    throw new Error(
      'Redis option "pkg" is not supported; use Postgres ConnectionOptions',
    );
  }
  if (raw.redis !== undefined) {
    throw new Error(
      'Redis option "redis" is not supported; pass a pg Pool as "pool"',
    );
  }
  if (typeof raw.database === "number") {
    throw new Error(
      'Connection option "database" must be a Postgres database name (string), not a Redis DB index',
    );
  }
}

function isPgBossNotInstalled(error: unknown): boolean {
  const message = toError(error).message.toLowerCase();
  return (
    message.includes("not installed") ||
    (message.includes("schema") && message.includes("missing"))
  );
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}
