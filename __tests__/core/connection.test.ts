import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { Connection } from "../../src";
import specHelper from "../utils/specHelper";

describe("connection", () => {
  beforeAll(async () => {
    await specHelper.connect();
    await specHelper.dropSchema();
    await specHelper.migrate();
    await specHelper.cleanup();
  });

  afterAll(async () => {
    await specHelper.cleanup();
    await specHelper.disconnect();
  });

  test("uses PostgreSQL-safe project defaults", () => {
    const connection = new Connection();
    expect(connection.schema).toBe("pgqueue");
    expect(connection.options.application_name).toBe("pg-queue");
  });

  test("should start with no redis keys in the namespace", async () => {
    // Adapt: after cleanup, no job rows and no pgrq_* rows
    const pool = await specHelper.connect();
    const jobCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${specHelper.schema}.pgrq_jobs`,
    );
    const lockCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${specHelper.schema}.pgrq_locks`,
    );
    const workerCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${specHelper.schema}.pgrq_workers`,
    );
    const leaderCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${specHelper.schema}.pgrq_leader`,
    );
    const statsCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${specHelper.schema}.pgrq_stats`,
    );

    expect(Number(jobCount.rows[0]?.count)).toBe(0);
    expect(Number(lockCount.rows[0]?.count)).toBe(0);
    expect(Number(workerCount.rows[0]?.count)).toBe(0);
    expect(Number(leaderCount.rows[0]?.count)).toBe(0);
    expect(Number(statsCount.rows[0]?.count)).toBe(0);
  });

  test.skip("it has loaded Lua commands", () => {
    // Skip: No Lua (Redis-only)
  });

  describe("keys and namespaces", () => {
    let connection: Connection;

    beforeAll(async () => {
      connection = new Connection(specHelper.cleanConnectionDetails());
      await connection.connect();
    });

    afterAll(async () => {
      await connection.end();
    });

    test.skip("getKeys returns appropriate keys based on matcher given", () => {
      // Skip: Redis SCAN
    });

    test.skip("keys built with the default namespace are correct", () => {
      // Skip: Redis key prefix
    });

    test.skip("ioredis transparent key prefix writes keys with the prefix even if they are not returned", () => {
      // Skip: Redis keyPrefix
    });

    test("keys built with a custom namespace are correct", async () => {
      // Adapt: `schema` selects the isolated pg-queue schema
      const customSchema = "custom_namespace_test";
      const custom = new Connection({
        connectionString: process.env.DATABASE_URL,
        schema: customSchema,
      });
      await custom.connect();
      await custom.migrate();

      expect(custom.schema).toBe(customSchema);

      const result = await custom.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'pgrq_locks'
         ) AS exists`,
        [customSchema],
      );
      expect(result.rows[0]?.exists).toBe(true);

      await custom.end();
      const pool = await specHelper.connect();
      await pool.query(`DROP SCHEMA IF EXISTS ${customSchema} CASCADE`);
    });

    test.skip("keys built with a array namespace are correct", () => {
      // Skip: array namespace not supported
    });

    test.skip("will properly build namespace strings dynamically", () => {
      // Skip: Redis namespace string building
    });

    test("key helper joins parts without a schema prefix", () => {
      expect(connection.key("lock", "add", "default")).toBe("lock:add:default");
      expect(connection.key("lock", "", "x")).toBe("lock:x");
    });
  });

  test("will select redis db from options", async () => {
    // Adapt: `database` string selects Postgres database
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl).toBeDefined();
    const url = new URL(databaseUrl ?? "");
    const connection = new Connection({
      host: url.hostname,
      port: Number(url.port || 5432),
      user: url.username,
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      schema: specHelper.schema,
    });
    await connection.connect();
    const result = await connection.query<{ current_database: string }>(
      "SELECT current_database()",
    );
    expect(result.rows[0]?.current_database).toBe(
      url.pathname.replace(/^\//, ""),
    );
    await connection.end();
  });

  test.skip("removes empty namespace from generated key", () => {
    // Skip: empty schema illegal; we reject
  });

  test("removes the postgres event listener when end", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const connection = new Connection({
      pool,
      schema: specHelper.schema,
    });
    await connection.connect();
    expect(pool.listenerCount("error")).toBe(1);
    await connection.end();
    expect(pool.listenerCount("error")).toBe(0);
    await pool.end();
  });

  test("connect with connectionString", async () => {
    const connection = new Connection(specHelper.cleanConnectionDetails());
    await connection.connect();
    expect(connection.connected).toBe(true);
    const result = await connection.query<{ value: number }>(
      "SELECT 1 AS value",
    );
    expect(result.rows[0]?.value).toBe(1);
    await connection.end();
  });

  test("connect is idempotent and supports reconnect after end", async () => {
    const connection = new Connection(specHelper.cleanConnectionDetails());
    await Promise.all([connection.connect(), connection.connect()]);
    expect(connection.connected).toBe(true);
    expect(connection.pool.listenerCount("error")).toBe(1);

    await connection.end();
    expect(connection.connected).toBe(false);
    expect(() => connection.pool).toThrow("Connection is not connected");

    await connection.connect();
    expect(connection.connected).toBe(true);
    await connection.end();
  });

  test("connect with discrete host/port/user/password/database", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl).toBeDefined();
    const url = new URL(databaseUrl ?? "");
    const connection = new Connection({
      host: url.hostname || "127.0.0.1",
      port: Number(url.port || 5432),
      user: url.username,
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      schema: specHelper.schema,
    });
    await connection.connect();
    expect(connection.connected).toBe(true);
    await connection.end();
  });

  test("connect with shared pool (ending Connection does not end the pool)", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const connection = new Connection({
      pool,
      schema: specHelper.schema,
    });
    await connection.connect();
    await connection.end();

    const result = await pool.query<{ value: number }>("SELECT 1 AS value");
    expect(result.rows[0]?.value).toBe(1);
    await pool.end();
  });

  test("reject illegal schema", () => {
    expect(() => new Connection({ schema: "pg-queue" })).toThrow(
      /Invalid schema/,
    );
    expect(() => new Connection({ schema: "public; drop" })).toThrow(
      /Invalid schema/,
    );
    expect(() => new Connection({ schema: "" })).toThrow(/Invalid schema/);
    expect(() => new Connection({ schema: "pg_queue" })).toThrow(
      /reserves the "pg_" prefix/,
    );
  });

  test("reject Redis options", () => {
    expect(
      () =>
        new Connection({
          // @ts-expect-error Redis option must be rejected at runtime
          pkg: "ioredis",
        }),
    ).toThrow(/pkg/);
    expect(
      () =>
        new Connection({
          // @ts-expect-error Redis option must be rejected at runtime
          redis: {},
        }),
    ).toThrow(/redis/);
    expect(
      () =>
        new Connection({
          // @ts-expect-error numeric database is Redis-only
          database: 0,
        }),
    ).toThrow(/database/);
  });

  test("migrate() creates all versioned pg-queue tables", async () => {
    const freshSchema = "pgrq_migrate_once";
    const pool = await specHelper.connect();
    await pool.query(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);

    const connection = new Connection({
      connectionString: process.env.DATABASE_URL,
      schema: freshSchema,
    });
    await connection.connect();
    await connection.migrate();

    const tables = await connection.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name = ANY($2::text[])
       ORDER BY table_name`,
      [
        freshSchema,
        [
          "pgrq_jobs",
          "pgrq_leader",
          "pgrq_locks",
          "pgrq_migrations",
          "pgrq_queues",
          "pgrq_stats",
          "pgrq_workers",
        ],
      ],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "pgrq_jobs",
      "pgrq_leader",
      "pgrq_locks",
      "pgrq_migrations",
      "pgrq_queues",
      "pgrq_stats",
      "pgrq_workers",
    ]);

    const migrations = await connection.query<{
      version: number;
      name: string;
    }>(
      `SELECT version, name FROM ${freshSchema}.pgrq_migrations ORDER BY version`,
    );
    expect(migrations.rows).toEqual([{ version: 1, name: "initial" }]);

    await connection.end();
    await pool.query(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);
  });

  test("second migrate() is a no-op", async () => {
    const connection = new Connection(specHelper.cleanConnectionDetails());
    await connection.connect();
    await connection.migrate();
    await connection.migrate();
    await connection.end();
  });

  test("concurrent migrate() calls serialize safely", async () => {
    const freshSchema = "pgrq_migrate_concurrent";
    const pool = await specHelper.connect();
    await pool.query(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);
    const a = new Connection({
      connectionString: process.env.DATABASE_URL,
      schema: freshSchema,
    });
    const b = new Connection({
      connectionString: process.env.DATABASE_URL,
      schema: freshSchema,
    });

    await Promise.all([a.migrate(), b.migrate()]);
    const result = await a.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${freshSchema}.pgrq_migrations`,
    );
    expect(Number(result.rows[0]?.count)).toBe(1);

    await Promise.all([a.end(), b.end()]);
    await pool.query(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);
  });

  test("migrate() can establish its own connection", async () => {
    const freshSchema = "pgrq_migrate_connect";
    const pool = await specHelper.connect();
    await pool.query(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);
    const connection = new Connection({
      connectionString: process.env.DATABASE_URL,
      schema: freshSchema,
    });

    await connection.migrate();
    expect(connection.connected).toBe(true);
    expect(
      (
        await connection.query<{ version: number }>(
          `SELECT version FROM ${freshSchema}.pgrq_migrations`,
        )
      ).rows,
    ).toEqual([{ version: 1 }]);

    await connection.end();
    await pool.query(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);
  });

  test("fetchJob atomically claims ready jobs and skips delayed jobs", async () => {
    await specHelper.cleanup();
    const connection = new Connection(specHelper.cleanConnectionDetails());
    await connection.connect();
    await connection.query(
      `INSERT INTO ${specHelper.schema}.pgrq_queues (name) VALUES ('claims')`,
    );
    await connection.query(
      `INSERT INTO ${specHelper.schema}.pgrq_jobs
         (name, data, priority, start_after)
       VALUES
         ('claims', '{"value":"low"}', 0, now()),
         ('claims', '{"value":"high"}', 10, now()),
         ('claims', '{"value":"later"}', 100, now() + interval '1 hour')`,
    );

    const [first, second] = await Promise.all([
      connection.fetchJob<{ value: string }>("claims"),
      connection.fetchJob<{ value: string }>("claims"),
    ]);
    expect(new Set([first?.id, second?.id]).size).toBe(2);
    expect([first?.data.value, second?.data.value].sort()).toEqual([
      "high",
      "low",
    ]);
    expect(await connection.fetchJob("claims")).toBeNull();

    const states = await connection.query<{ state: string; count: string }>(
      `SELECT state, count(*)::text AS count
       FROM ${specHelper.schema}.pgrq_jobs
       GROUP BY state
       ORDER BY state`,
    );
    expect(states.rows).toEqual([
      { state: "active", count: "2" },
      { state: "created", count: "1" },
    ]);
    await connection.end();
  });

  test("tryLeader: only one of two connections wins; after expiry the other wins", async () => {
    await specHelper.cleanup();
    const a = new Connection(specHelper.cleanConnectionDetails());
    const b = new Connection(specHelper.cleanConnectionDetails());
    await a.connect();
    await b.connect();

    expect(await a.tryLeader("leader-a", 2)).toBe(true);
    expect(await b.tryLeader("leader-b", 2)).toBe(false);
    expect(await a.currentLeader()).toBe("leader-a");

    // Wait for TTL expiry
    await Bun.sleep(2100);
    expect(await b.tryLeader("leader-b", 30)).toBe(true);
    expect(await b.currentLeader()).toBe("leader-b");

    expect(await b.releaseLeader("leader-b")).toBe(true);
    expect(await b.currentLeader()).toBeNull();

    await a.end();
    await b.end();
  });

  test("setLockNx / expire / delLock", async () => {
    await specHelper.cleanup();
    const connection = new Connection(specHelper.cleanConnectionDetails());
    await connection.connect();

    expect(await connection.setLockNx("lock:test", "owner-a", 30)).toBe(true);
    expect(await connection.setLockNx("lock:test", "owner-b", 30)).toBe(false);
    expect(await connection.getLock("lock:test")).toBe("owner-a");

    await connection.expireLock("lock:test", 1);
    await Bun.sleep(1100);
    expect(await connection.getLock("lock:test")).toBeNull();
    expect(await connection.setLockNx("lock:test", "owner-b", 30)).toBe(true);

    expect(await connection.delLock("lock:test")).toBe(1);
    expect(await connection.getLock("lock:test")).toBeNull();

    await connection.incrStat("processed", 2);
    await connection.decrStat("processed", 1);
    expect(await connection.getStats()).toEqual({ processed: 1 });

    await connection.end();
  });
});
