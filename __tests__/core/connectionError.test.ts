import { describe, expect, test } from "bun:test";
import { Connection } from "../../src";

describe("connection error", () => {
  test("can provide an error if connection failed", async () => {
    await new Promise<void>((resolve, reject) => {
      const brokenConnection = new Connection({
        host: "127.0.0.1",
        port: 1,
        database: "pgboss_queue_test",
        user: "postgres",
        password: "postgres",
        schema: "pgboss_queue_test",
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
          resolve();
        });
    });
  }, 60_000);
});
