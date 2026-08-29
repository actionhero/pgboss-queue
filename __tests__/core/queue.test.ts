import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  type JobDefinition,
  type ParsedJob,
  Plugin,
  Queue,
} from "../../src/index.js";
import specHelper from "../utils/specHelper.js";

let queue: Queue;
const delayedBase = () => Math.round((Date.now() + 60_000) / 1000) * 1000;

describe("queue", () => {
  beforeAll(async () => {
    await specHelper.connect();
    await specHelper.dropSchema();
    await specHelper.migrate();
  });

  afterAll(async () => {
    await queue?.end();
    await specHelper.cleanup();
    await specHelper.disconnect();
  });

  test("can connect", async () => {
    const standalone = new Queue({
      connection: specHelper.cleanConnectionDetails(),
      queue: specHelper.queue,
    });
    await standalone.connect();
    await standalone.end();
  });

  describe("[with connection]", () => {
    beforeAll(async () => {
      queue = new Queue(
        { connection: specHelper.cleanConnectionDetails() },
        {},
      );
      await queue.connect();
    });

    beforeEach(async () => {
      await specHelper.cleanup();
    });

    test("can add a normal job", async () => {
      expect(await queue.enqueue(specHelper.queue, "someJob", [1, 2, 3])).toBe(
        true,
      );
      const raw = await specHelper.popFromQueue();
      expect(raw).not.toBeNull();
      const job = JSON.parse(raw ?? "{}") as ParsedJob;
      expect(job.class).toBe("someJob");
      expect(job.args).toEqual([1, 2, 3]);
    });

    test("can add delayed job (enqueueAt)", async () => {
      const timestamp = delayedBase();
      await queue.enqueueAt(timestamp, specHelper.queue, "someJob", [1, 2, 3]);
      const { tasks } = await queue.delayedAt(timestamp);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.class).toBe("someJob");
      expect(tasks[0]?.args).toEqual([1, 2, 3]);
    });

    test("can add delayed job whose timestamp is a string (enqueueAt)", async () => {
      const timestamp = delayedBase();
      await queue.enqueueAt(
        String(timestamp),
        specHelper.queue,
        "someJob",
        [1, 2, 3],
      );
      expect((await queue.delayedAt(timestamp)).tasks).toHaveLength(1);
    });

    test("will not enqueue a delayed job at the same time with matching params with error", async () => {
      const timestamp = delayedBase();
      await queue.enqueueAt(timestamp, specHelper.queue, "someJob", [1, 2, 3]);
      await expect(
        queue.enqueueAt(timestamp, specHelper.queue, "someJob", [1, 2, 3]),
      ).rejects.toThrow(
        "Job already enqueued at this time with same arguments",
      );
      expect((await queue.delayedAt(timestamp)).tasks).toHaveLength(1);
    });

    test("will not enqueue a delayed job at the same time with matching params with error suppressed", async () => {
      const timestamp = delayedBase();
      await queue.enqueueAt(timestamp, specHelper.queue, "someJob", [1, 2, 3]);
      expect(
        await queue.enqueueAt(
          timestamp,
          specHelper.queue,
          "someJob",
          [1, 2, 3],
          true,
        ),
      ).toBeUndefined();
      expect((await queue.delayedAt(timestamp)).tasks).toHaveLength(1);
    });

    test("can add delayed job (enqueueIn)", async () => {
      await queue.enqueueIn(60_000, specHelper.queue, "someJob", [1, 2, 3]);
      expect(await queue.timestamps()).toHaveLength(1);
    });

    test("can add a delayed job whose time is a string (enqueueIn)", async () => {
      await queue.enqueueIn("60000", specHelper.queue, "someJob", [1, 2, 3]);
      expect(await queue.timestamps()).toHaveLength(1);
    });

    test("can get the number of jobs currently enqueued", async () => {
      await queue.enqueue(specHelper.queue, "someJob", [1]);
      await queue.enqueue(specHelper.queue, "someJob", [2]);
      await queue.enqueueIn(60_000, specHelper.queue, "someJob", [3]);
      expect(await queue.length(specHelper.queue)).toBe(2);
    });

    test("can get the jobs in the queue", async () => {
      await queue.enqueue(specHelper.queue, "someJob", [1, 2, 3]);
      await queue.enqueue(specHelper.queue, "someJob", [4, 5, 6]);
      const jobs = await queue.queued(specHelper.queue, 0, -1);
      expect(jobs.map((job) => job.args)).toEqual([
        [1, 2, 3],
        [4, 5, 6],
      ]);
      expect(await queue.queued(specHelper.queue, 1, 1)).toHaveLength(1);
    });

    test("can find previously scheduled jobs", async () => {
      const timestamp = delayedBase();
      await queue.enqueueAt(timestamp, specHelper.queue, "someJob", [1, 2, 3]);
      expect(
        await queue.scheduledAt(specHelper.queue, "someJob", [1, 2, 3]),
      ).toEqual([timestamp / 1000]);
    });

    test("will not match previously scheduled jobs with differnt args", async () => {
      await queue.enqueueAt(
        delayedBase(),
        specHelper.queue,
        "someJob",
        [1, 2, 3],
      );
      expect(
        await queue.scheduledAt(specHelper.queue, "someJob", [3, 2, 1]),
      ).toEqual([]);
    });

    test("can delete an enqueued job", async () => {
      await queue.enqueue(specHelper.queue, "someJob", [1, 2, 3]);
      expect(await queue.del(specHelper.queue, "someJob", [1, 2, 3])).toBe(1);
      expect(await queue.length(specHelper.queue)).toBe(0);
    });

    test("can delete all enqueued jobs of a particular function/class", async () => {
      await queue.enqueue(specHelper.queue, "someJob1", [1]);
      await queue.enqueue(specHelper.queue, "someJob1", [2]);
      await queue.enqueue(specHelper.queue, "someJob2", [3]);
      expect(await queue.delByFunction(specHelper.queue, "someJob1")).toBe(2);
      expect(await queue.length(specHelper.queue)).toBe(1);
    });

    test("can delete a delayed job", async () => {
      const timestamp = delayedBase();
      await queue.enqueueAt(timestamp, specHelper.queue, "someJob", [1, 2, 3]);
      expect(
        await queue.delDelayed(specHelper.queue, "someJob", [1, 2, 3]),
      ).toEqual([timestamp / 1000]);
    });

    test("can delete a delayed job, and delayed queue should be empty", async () => {
      await queue.enqueueAt(
        delayedBase(),
        specHelper.queue,
        "someJob",
        [1, 2, 3],
      );
      await queue.delDelayed(specHelper.queue, "someJob", [1, 2, 3]);
      expect(await queue.allDelayed()).toEqual({});
    });

    test("can handle single arguments without explicit array", async () => {
      await queue.enqueue(specHelper.queue, "someJob", 1);
      const job = JSON.parse(
        (await specHelper.popFromQueue()) ?? "{}",
      ) as ParsedJob;
      expect(job.args).toEqual([1]);
    });

    test("allows omitting arguments when enqueuing", async () => {
      await queue.enqueue(specHelper.queue, "noParams");
      expect((await queue.queued(specHelper.queue, 0, -1))[0]?.args).toEqual(
        [],
      );
    });

    test("allows omitting arguments when deleting", async () => {
      await queue.enqueue(specHelper.queue, "noParams");
      await queue.enqueue(specHelper.queue, "noParams");
      expect(await queue.del(specHelper.queue, "noParams")).toBe(2);
    });

    test("allows omitting arguments when adding delayed job", async () => {
      const timestamp = delayedBase();
      await queue.enqueueAt(timestamp, specHelper.queue, "noParams");
      await queue.enqueueAt(timestamp + 2000, specHelper.queue, "noParams");
      expect(
        await queue.scheduledAt(specHelper.queue, "noParams"),
      ).toHaveLength(2);
    });

    test("allows omitting arguments when deleting a delayed job", async () => {
      await queue.enqueueAt(delayedBase(), specHelper.queue, "noParams");
      expect(await queue.delDelayed(specHelper.queue, "noParams")).toHaveLength(
        1,
      );
      expect(await queue.allDelayed()).toEqual({});
    });

    test("can determine who the leader is", async () => {
      expect(await queue.connection.tryLeader("the_scheduler", 60)).toBe(true);
      expect(await queue.leader()).toBe("the_scheduler");
      expect(queue.leaderKey()).not.toBe("");
    });

    test("can load stats", async () => {
      await queue.connection.incrStat("failed", 1);
      await queue.connection.incrStat("processed", 2);
      expect(await queue.stats()).toEqual({ failed: "1", processed: "2" });
    });

    describe("locks", () => {
      beforeEach(async () => {
        await queue.connection.setLockNx(
          "lock:lists:queueName:jobName:[{}]",
          "123",
          60,
        );
        await queue.connection.setLockNx(
          "workerslock:lists:queueName:jobName:[{}]",
          "456",
          60,
        );
      });

      test("can get locks", async () => {
        expect(await queue.locks()).toEqual({
          "lock:lists:queueName:jobName:[{}]": "123",
          "workerslock:lists:queueName:jobName:[{}]": "456",
        });
      });

      test("can remove locks", async () => {
        expect(
          await queue.delLock("workerslock:lists:queueName:jobName:[{}]"),
        ).toBe(1);
      });
    });

    describe("failed job managment", () => {
      beforeEach(async () => {
        for (let id = 1; id <= 3; id += 1) {
          await queue.enqueue("busted-queue", "busted_job", [id, 2, 3]);
          await queue.connection.query(
            `UPDATE ${specHelper.schema}.job
             SET state = 'failed',
                 completed_on = now() + make_interval(secs => $1),
                 output = $2::jsonb
             WHERE data->'args'->>0 = $3`,
            [
              id,
              JSON.stringify({
                worker: `busted-worker-${id}`,
                queue: "busted-queue",
                exception: "ERROR_NAME",
                error: "I broke",
                backtrace: [],
              }),
              String(id),
            ],
          );
        }
      });

      test("can list how many failed jobs there are", async () => {
        expect(await queue.failedCount()).toBe(3);
      });

      test("can get the body content for a collection of failed jobs", async () => {
        const failed = await queue.failed(1, 2);
        expect(failed).toHaveLength(2);
        expect(failed[0]?.worker).toBe("busted-worker-2");
        expect(failed[1]?.payload.args).toEqual([3, 2, 3]);
      });

      test("can remove a failed job by payload", async () => {
        const [failed] = await queue.failed(1, 1);
        if (!failed) throw new Error("expected a failed job");
        expect(await queue.removeFailed(failed)).toBe(1);
        expect(await queue.failedCount()).toBe(2);
      });

      test("can re-enqueue a specific job, removing it from the failed queue", async () => {
        const failed = await queue.failed(0, -1);
        const target = failed[2];
        if (!target) throw new Error("expected a failed job");
        expect(await queue.retryAndRemoveFailed(target)).toBe(true);
        expect(await queue.failedCount()).toBe(2);
        expect(await queue.length("busted-queue")).toBe(1);
      });

      test("will return an error when trying to retry a job not in the failed queue", async () => {
        const [failed] = await queue.failed(2, 2);
        if (!failed) throw new Error("expected a failed job");
        failed.worker = "a-fake-worker";
        await expect(queue.retryAndRemoveFailed(failed)).rejects.toThrow(
          "This job is not in failed queue",
        );
        expect(await queue.failedCount()).toBe(3);
      });
    });

    describe("delayed status", () => {
      test("can list the timestamps that exist", async () => {
        const timestamp = delayedBase();
        await queue.enqueueAt(timestamp, specHelper.queue, "job1", [1]);
        await queue.enqueueAt(timestamp, specHelper.queue, "job2", [1]);
        await queue.enqueueAt(timestamp + 2000, specHelper.queue, "job3", [1]);
        expect(await queue.timestamps()).toEqual([timestamp, timestamp + 2000]);
      });

      test("can list the jobs delayed at a timestamp", async () => {
        const timestamp = delayedBase();
        await queue.enqueueAt(timestamp, specHelper.queue, "job1", [1]);
        await queue.enqueueAt(timestamp, specHelper.queue, "job2", [1]);
        const delayed = await queue.delayedAt(timestamp);
        expect(delayed.rTimestamp).toBe(timestamp / 1000);
        expect(delayed.tasks.map((task) => task.class)).toEqual([
          "job1",
          "job2",
        ]);
      });

      test("can also return a hash with all delayed tasks", async () => {
        const timestamp = delayedBase();
        await queue.enqueueAt(timestamp, specHelper.queue, "job1", [1]);
        await queue.enqueueAt(timestamp + 2000, specHelper.queue, "job2", [1]);
        expect(Object.keys(await queue.allDelayed())).toEqual([
          String(timestamp),
          String(timestamp + 2000),
        ]);
      });

      test("does not list already-ready jobs as delayed", async () => {
        const timestamp = Math.round((Date.now() - 5000) / 1000) * 1000;
        await queue.enqueueAt(timestamp, specHelper.queue, "job1", [1]);
        expect((await queue.delayedAt(timestamp)).tasks).toHaveLength(0);
        expect(await queue.length(specHelper.queue)).toBe(1);
      });
    });

    test("runs enqueue plugins in order and honors vetoes", async () => {
      const calls: string[] = [];
      class TrackingPlugin extends Plugin {
        override beforeEnqueue(): boolean {
          calls.push("before");
          return this.options.veto !== true;
        }

        override afterEnqueue(): boolean {
          calls.push("after");
          return true;
        }
      }
      const jobs: Record<string, JobDefinition> = {
        allowed: {
          plugins: [TrackingPlugin],
          perform: async () => undefined,
        },
        vetoed: {
          plugins: [TrackingPlugin],
          pluginOptions: { TrackingPlugin: { veto: true } },
          perform: async () => undefined,
        },
      };
      const pluginQueue = new Queue(
        { connection: specHelper.cleanConnectionDetails() },
        jobs,
      );
      await pluginQueue.connect();
      expect(await pluginQueue.enqueue(specHelper.queue, "allowed")).toBe(true);
      expect(await pluginQueue.enqueue(specHelper.queue, "vetoed")).toBe(false);
      expect(calls).toEqual(["before", "after", "before"]);
      await pluginQueue.end();
    });

    test("lists configured queues and deletes a queue", async () => {
      await queue.enqueue("temporary", "job");
      expect(await queue.queues()).toContain("temporary");
      expect(await queue.delQueue("temporary")).toBe(1);
      expect(await queue.queues()).not.toContain("temporary");
    });

    test("can re-enqueue after another instance deletes the queue", async () => {
      const other = new Queue({
        connection: specHelper.cleanConnectionDetails(),
      });
      await other.connect();
      await queue.enqueue("recycle", "job", [1]);
      expect(await other.delQueue("recycle")).toBe(1);
      expect(await queue.enqueue("recycle", "job", [2])).toBe(true);
      expect(await queue.length("recycle")).toBe(1);
      await other.end();
    });

    test("does not drop jobs that remain after delQueue", async () => {
      await queue.enqueue("busy", "job", [1]);
      await queue.connection.query(
        `UPDATE ${specHelper.schema}.job
         SET state = 'active'
         WHERE name = 'busy'`,
      );
      expect(await queue.delQueue("busy")).toBe(0);
      expect(await queue.queues()).toContain("busy");
      expect(await queue.enqueue("busy", "job", [2])).toBe(true);
      expect(await queue.length("busy")).toBe(1);
    });

    test("forceCleanWorker fails the original active job", async () => {
      expect(await queue.enqueue("stuck", "slowJob", [{ a: 1 }])).toBe(true);
      const fetched = await queue.connection.boss.fetch<{
        class: string;
        queue: string;
        args: unknown[];
      }>("stuck", { batchSize: 1 });
      const job = fetched[0];
      if (!job) throw new Error("expected an active job");
      await queue.connection.query(
        `INSERT INTO ${specHelper.schema}.pgrq_workers (name, queues, working_on)
         VALUES ('workerA', $1, $2::jsonb)`,
        [
          "stuck",
          JSON.stringify({
            id: job.id,
            run_at: new Date().toString(),
            queue: "stuck",
            worker: "workerA",
            payload: job.data,
          }),
        ],
      );

      const errorPayload = await queue.forceCleanWorker("workerA");
      expect(errorPayload?.exception).toBe("Worker Timeout (killed manually)");
      expect(await queue.failedCount()).toBe(1);
      const failed = await queue.failed(0, -1);
      expect(failed[0]?.id).toBe(job.id);
      expect(failed[0]?.payload.args).toEqual([{ a: 1 }]);

      const active = await queue.connection.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM ${specHelper.schema}.job
         WHERE name = 'stuck' AND state = 'active'`,
      );
      expect(Number(active.rows[0]?.count)).toBe(0);
    });

    test("forceCleanWorker without a job id fails only one matching active job", async () => {
      await queue.enqueue("twins", "slowJob", [1]);
      await queue.enqueue("twins", "slowJob", [1]);
      const fetched = await queue.connection.boss.fetch<{
        class: string;
        queue: string;
        args: unknown[];
      }>("twins", { batchSize: 2 });
      expect(fetched).toHaveLength(2);
      await queue.connection.query(
        `INSERT INTO ${specHelper.schema}.pgrq_workers (name, queues, working_on)
         VALUES ('workerA', 'twins', $1::jsonb)`,
        [
          JSON.stringify({
            run_at: new Date().toString(),
            queue: "twins",
            worker: "workerA",
            payload: fetched[0]?.data,
          }),
        ],
      );

      await queue.forceCleanWorker("workerA");
      expect(await queue.failedCount()).toBe(1);
      const active = await queue.connection.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM ${specHelper.schema}.job
         WHERE name = 'twins' AND state = 'active'`,
      );
      expect(Number(active.rows[0]?.count)).toBe(1);
    });

    test("can list running workers", async () => {
      await queue.connection.query(
        `INSERT INTO ${specHelper.schema}.pgrq_workers (name, queues)
         VALUES ('workerA', $1), ('workerB', $1)`,
        [specHelper.queue],
      );
      expect(await queue.workers()).toEqual({
        workerA: specHelper.queue,
        workerB: specHelper.queue,
      });
    });

    test("we can see what workers are working on (idle)", async () => {
      await queue.connection.query(
        `INSERT INTO ${specHelper.schema}.pgrq_workers (name, queues)
         VALUES ('workerA', $1), ('workerB', $1)`,
        [specHelper.queue],
      );
      expect(await queue.allWorkingOn()).toEqual({
        workerA: "started",
        workerB: "started",
      });
      expect(await queue.workingOn("workerA", specHelper.queue)).toBeNull();
    });

    test.skip("we can see what workers are working on (active)", () => {
      // Phase 4: requires a live Worker.
    });

    test.skip("can remove stuck workers and re-enqueue their jobs", () => {
      // Phase 4: requires a live Worker.
    });

    test.skip("will not remove stuck jobs within the time limit", () => {
      // Phase 4: requires a live Worker.
    });

    test.skip("can forceClean a worker, returning the error payload", () => {
      // Phase 4: requires a live Worker.
    });

    test.skip("can forceClean a worker, returning the error payload and removing all keys it had set in redis", () => {
      // Phase 4: requires a live Worker.
    });

    test.skip("retryStuckJobs", () => {
      // Phase 4: requires a live Worker.
    });
  });
});
