import { describe, expect, test } from "bun:test";
import { Connection } from "../../src";

describe("connection error", () => {
  test("can provide an error if connection failed", async () => {
    await new Promise<void>((resolve, reject) => {
      const brokenConnection = new Connection({
        host: "127.0.0.1",
        port: 1,
        database: "pgqueue_test",
        user: "postgres",
        password: "postgres",
        schema: "pgqueue_test",
      });

      let sawErrorEvent = false;

      brokenConnection.on("error", (error: Error) => {
        sawErrorEvent = true;
        expect(error.message).toMatch(
          /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|connect/i,
        );
      });

      brokenConnection
        .connect()
        .then(() => {
          reject(new Error("expected connect() to fail"));
        })
        .catch((error: Error) => {
          expect(error.message).toMatch(
            /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|connect/i,
          );
          expect(sawErrorEvent).toBe(true);
          expect(brokenConnection.connected).toBe(false);
          expect(() => brokenConnection.pool).toThrow(
            "Connection is not connected",
          );
          resolve();
        });
    });
  }, 60_000);

  test("migrate() tears down a failed bootstrap pool", async () => {
    const brokenConnection = new Connection({
      host: "127.0.0.1",
      port: 1,
      database: "pgqueue_test",
      user: "postgres",
      password: "postgres",
      schema: "pgqueue_test",
    });
    brokenConnection.on("error", () => {
      // connect() also emits; the rejection is the assertion
    });

    await expect(brokenConnection.migrate()).rejects.toThrow(
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|connect/i,
    );
    expect(brokenConnection.connected).toBe(false);
    expect(() => brokenConnection.pool).toThrow("Connection is not connected");
  }, 60_000);
});
