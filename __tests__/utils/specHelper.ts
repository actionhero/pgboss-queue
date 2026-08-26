import { Pool, type PoolConfig } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required to run the test suite. See .env.example.",
  );
}

export const connectionDetails: PoolConfig = { connectionString };
export const timeout = 500;
export const queue = "default";
export const schema = "pgboss_queue_test";

let pool: Pool | undefined;

export async function connect(): Promise<Pool> {
  pool ??= new Pool(connectionDetails);
  await pool.query("SELECT 1");
  return pool;
}

export async function disconnect(): Promise<void> {
  if (!pool) return;

  await pool.end();
  pool = undefined;
}

export async function cleanup(): Promise<void> {
  const connection = await connect();
  await connection.query("SELECT 1");
}

export async function popFromQueue(): Promise<never> {
  throw new Error("not implemented");
}
