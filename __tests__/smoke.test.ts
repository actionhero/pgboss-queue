import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { connect, disconnect } from "./utils/specHelper.ts";

describe("Postgres smoke test", () => {
  after(disconnect);

  test("DATABASE_URL is defined", () => {
    assert.ok(process.env.DATABASE_URL);
  });

  test("SELECT 1 returns 1", async () => {
    const pool = await connect();
    const result = await pool.query<{ value: number }>("SELECT 1 AS value");

    assert.equal(result.rows[0]?.value, 1);
  });
});
