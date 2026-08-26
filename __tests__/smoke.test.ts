import { afterAll, describe, expect, test } from "bun:test";
import { connect, disconnect } from "./utils/specHelper";

describe("Postgres smoke test", () => {
  afterAll(disconnect);

  test("DATABASE_URL is defined", () => {
    expect(process.env.DATABASE_URL).toBeDefined();
  });

  test("SELECT 1 returns 1", async () => {
    const pool = await connect();
    const result = await pool.query<{ value: number }>("SELECT 1 AS value");

    expect(result.rows[0]?.value).toBe(1);
  });
});
