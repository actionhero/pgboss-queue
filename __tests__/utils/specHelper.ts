import { Pool, type PoolConfig } from "pg";
import {
  Connection,
  type ConnectionOptions,
} from "../../src/core/connection.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required to run the test suite. See .env.example.",
  );
}

export const schema = "pgqueue_test";
export const timeout = 500;
export const queue = "default";

/** Connection options shared by tests (Postgres URL + isolated schema). */
export const connectionDetails: ConnectionOptions = {
  connectionString,
  schema,
};

let pool: Pool | undefined;

/**
 * Clone connection details for a fresh Connection (avoids shared mutation).
 * @returns A shallow copy of {@link connectionDetails}.
 */
export function cleanConnectionDetails(): ConnectionOptions {
  return { ...connectionDetails };
}

/**
 * Open (or reuse) the shared helper pool and verify connectivity.
 * @returns The shared `pg.Pool`.
 */
export async function connect(): Promise<Pool> {
  pool ??= new Pool(connectionDetails as PoolConfig);
  await pool.query("SELECT 1");
  return pool;
}

/**
 * End the shared helper pool if open.
 */
export async function disconnect(): Promise<void> {
  if (!pool) return;

  await pool.end();
  pool = undefined;
}

/**
 * Install all versioned pg-queue tables into the test schema (idempotent).
 */
export async function migrate(): Promise<void> {
  const connection = new Connection(cleanConnectionDetails());
  await connection.connect();
  await connection.migrate();
  await connection.end();
}

/**
 * Truncate job and metadata tables so tests start from an empty schema.
 * No-op if the schema has not been migrated yet.
 */
export async function cleanup(): Promise<void> {
  const connection = await connect();

  const schemaExists = await connection.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
     ) AS exists`,
    [schema],
  );

  if (!schemaExists.rows[0]?.exists) {
    return;
  }

  const tables = await connection.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_name = ANY($2::text[])`,
    [
      schema,
      [
        "pgrq_jobs",
        "pgrq_queues",
        "pgrq_leader",
        "pgrq_workers",
        "pgrq_locks",
        "pgrq_stats",
      ],
    ],
  );

  const names = new Set(tables.rows.map((row) => row.table_name));

  const dataTables = [
    "pgrq_jobs",
    "pgrq_queues",
    "pgrq_leader",
    "pgrq_workers",
    "pgrq_locks",
    "pgrq_stats",
  ].filter((name) => names.has(name));

  if (dataTables.length > 0) {
    await connection.query(
      `TRUNCATE TABLE ${dataTables
        .map((name) => `${schema}.${name}`)
        .join(", ")}`,
    );
  }
}

/**
 * Drop the entire test schema (CASCADE). Used between files when needed.
 */
export async function dropSchema(): Promise<void> {
  const connection = await connect();
  await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

/**
 * Fetch and remove one ready job from the default test queue.
 *
 * @returns The node-resque encoded payload, or `null` when the queue is empty.
 */
export async function popFromQueue(): Promise<string | null> {
  const connection = new Connection(cleanConnectionDetails());
  await connection.connect();
  try {
    const job = await connection.fetchJob<{
      class: string;
      queue: string;
      args: unknown[];
    }>(queue);
    if (!job) return null;
    await connection.deleteJob(queue, job.id);
    return JSON.stringify(job.data);
  } finally {
    await connection.end();
  }
}

const specHelper = {
  connectionDetails,
  cleanConnectionDetails,
  timeout,
  queue,
  schema,
  connect,
  disconnect,
  migrate,
  cleanup,
  dropSchema,
  popFromQueue,
};

export default specHelper;
