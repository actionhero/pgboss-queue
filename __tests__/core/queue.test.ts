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

async function seedActiveWorker(
  target: Queue,
  worker: string,
  queueName: string,
  args: unknown[],
  runAt: Date,
  includeId = true,
): Promise<string> {
  await target.enqueue(queueName, "slowJob", args);
  const job = await target.connection.fetchJob<ParsedJob>(queueName);
  if (!job) throw new Error("expected an active job");
  await target.connection.query(
    `INSERT INTO ${specHelper.schema}.pgrq_workers (name, queues, working_on)
     VALUES ($1, $2, $3::jsonb)`,
    [
      worker,
      queueName,
      JSON.stringify({
        ...(includeId ? { id: job.id } : {}),
        run_at: runAt.toString(),
        queue: queueName,
        worker,
        payload: job.data,
      }),
    ],
  );
  return job.id;
}

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

    test("concurrent Queue instances only enqueue one matching delayed job", async () => {
      const other = new Queue({
        connection: specHelper.cleanConnectionDetails(),
      });
      await other.connect();
      const timestamp = delayedBase();
      const settled = await Promise.allSettled([
        queue.enqueueAt(timestamp, specHelper.queue, "someJob", [{ id: 1 }]),
        other.enqueueAt(timestamp, specHelper.queue, "someJob", [{ id: 1 }]),
      ]);
      expect(
        settled.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        settled.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect((await queue.delayedAt(timestamp)).tasks).toHaveLength(1);
      await other.end();
    });

    test("can schedule a delayed job whose payload exceeds a btree key", async () => {
      const timestamp = delayedBase();
      const args = ["x".repeat(8_000)];
      expect(
        await queue.enqueueAt(timestamp, specHelper.queue, "someJob", args),
      ).toBe(true);
      await expect(
        queue.enqueueAt(timestamp, specHelper.queue, "someJob", args),
      ).rejects.toThrow(
        "Job already enqueued at this time with same arguments",
      );
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

    test("del honors positive and negative count direction", async () => {
      const ids = async () => {
        const result = await queue.connection.query<{ id: string }>(
          `SELECT id
           FROM ${specHelper.schema}.pgrq_jobs
           WHERE name = $1 AND state = 'created'
           ORDER BY created_on, id`,
          [specHelper.queue],
        );
        return result.rows.map((row) => row.id);
      };

      for (let index = 0; index < 3; index += 1) {
        await queue.enqueue(specHelper.queue, "sameJob", [1]);
      }
      const original = await ids();
      expect(await queue.del(specHelper.queue, "sameJob", [1], 1)).toBe(1);
      expect(await ids()).toEqual(original.slice(1));

      await specHelper.cleanup();
      for (let index = 0; index < 3; index += 1) {
        await queue.enqueue(specHelper.queue, "sameJob", [1]);
      }
      const reloaded = await ids();
      expect(await queue.del(specHelper.queue, "sameJob", [1], -1)).toBe(1);
      expect(await ids()).toEqual(reloaded.slice(0, -1));
    });

    test("can delete all enqueued jobs of a particular function/class", async () => {
      await queue.enqueue(specHelper.queue, "someJob1", [1]);
      await queue.enqueue(specHelper.queue, "someJob1", [2]);
      await queue.enqueue(specHelper.queue, "someJob2", [3]);
      expect(await queue.delByFunction(specHelper.queue, "someJob1")).toBe(2);
      expect(await queue.length(specHelper.queue)).toBe(1);
    });

    test("delByFunction only deletes matches inside its slice", async () => {
      await queue.enqueue(specHelper.queue, "someJob1", [1]);
      await queue.enqueue(specHelper.queue, "someJob2", [2]);
      await queue.enqueue(specHelper.queue, "someJob1", [3]);
      expect(
        await queue.delByFunction(specHelper.queue, "someJob1", 1, 2),
      ).toBe(1);
      expect(
        (await queue.queued(specHelper.queue, 0, -1)).map((job) => job.class),
      ).toEqual(["someJob1", "someJob2"]);
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

    test("can re-schedule after delQueue of object args", async () => {
      const timestamp = delayedBase();
      const args = [{ z: 1, a: 2 }];
      await queue.enqueueAt(timestamp, "object-queue", "someJob", args);
      expect(await queue.delQueue("object-queue")).toBe(1);
      expect(
        await queue.enqueueAt(timestamp, "object-queue", "someJob", args),
      ).toBe(true);
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

      test("does not return expired locks", async () => {
        await queue.connection.query(
          `UPDATE ${specHelper.schema}.pgrq_locks
           SET expires_at = now() - interval '1 second'`,
        );
        expect(await queue.locks()).toEqual({});
        const count = await queue.connection.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM ${specHelper.schema}.pgrq_locks`,
        );
        expect(Number(count.rows[0]?.count)).toBe(0);
      });
    });

    describe("failed job managment", () => {
      beforeEach(async () => {
        for (let id = 1; id <= 3; id += 1) {
          await queue.enqueue("busted-queue", "busted_job", [id, 2, 3]);
          await queue.connection.query(
            `UPDATE ${specHelper.schema}.pgrq_jobs
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

    test("queue row locking serializes enqueue with queue deletion", async () => {
      const other = new Queue({
        connection: specHelper.cleanConnectionDetails(),
      });
      await other.connect();
      await queue.enqueue("serialized", "job", [1]);
      const client = await queue.connection.pool.connect();
      await client.query("BEGIN");
      await client.query(
        `SELECT name
         FROM ${specHelper.schema}.pgrq_queues
         WHERE name = 'serialized'
         FOR UPDATE`,
      );

      let settled = false;
      const enqueue = other.enqueue("serialized", "job", [2]).then((value) => {
        settled = true;
        return value;
      });
      await Bun.sleep(25);
      expect(settled).toBe(false);
      await client.query("COMMIT");
      client.release();

      expect(await enqueue).toBe(true);
      expect(await queue.length("serialized")).toBe(2);
      await other.end();
    });

    test("does not drop jobs that remain after delQueue", async () => {
      await queue.enqueue("busy", "job", [1]);
      await queue.connection.query(
        `UPDATE ${specHelper.schema}.pgrq_jobs
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
      const job = await queue.connection.fetchJob<{
        class: string;
        queue: string;
        args: unknown[];
      }>("stuck");
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
         FROM ${specHelper.schema}.pgrq_jobs
         WHERE name = 'stuck' AND state = 'active'`,
      );
      expect(Number(active.rows[0]?.count)).toBe(0);
    });

    test("forceCleanWorker without a job id fails only one matching active job", async () => {
      await queue.enqueue("twins", "slowJob", [1]);
      await queue.enqueue("twins", "slowJob", [1]);
      const fetched = await Promise.all([
        queue.connection.fetchJob<{
          class: string;
          queue: string;
          args: unknown[];
        }>("twins"),
        queue.connection.fetchJob<{
          class: string;
          queue: string;
          args: unknown[];
        }>("twins"),
      ]);
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
         FROM ${specHelper.schema}.pgrq_jobs
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

    test("we can see what workers are working on (active)", async () => {
      const runAt = new Date();
      await seedActiveWorker(
        queue,
        "workerA",
        "active-status",
        [{ a: 1 }],
        runAt,
      );
      const working = await queue.allWorkingOn();
      expect(working.workerA).not.toBe("started");
      if (working.workerA === "started" || !working.workerA) {
        throw new Error("expected active worker payload");
      }
      expect(working.workerA.payload.args).toEqual([{ a: 1 }]);
      expect(Date.parse(working.workerA.run_at)).toBe(
        Math.floor(runAt.getTime() / 1000) * 1000,
      );
    });

    test("can remove stuck workers and re-enqueue their jobs", async () => {
      await seedActiveWorker(
        queue,
        "workerA",
        "stuck-clean",
        [{ a: 1 }],
        new Date(Date.now() - 10_000),
      );
      const cleaned = await queue.cleanOldWorkers(1_000);
      expect(cleaned.workerA?.payload.args).toEqual([{ a: 1 }]);
      expect(await queue.failedCount()).toBe(1);
      await queue.retryStuckJobs();
      expect(await queue.failedCount()).toBe(0);
      expect(await queue.length("stuck-clean")).toBe(1);
    });

    test("will not remove stuck jobs within the time limit", async () => {
      await seedActiveWorker(queue, "workerA", "recent-worker", [], new Date());
      expect(await queue.cleanOldWorkers(60_000)).toEqual({});
      expect(await queue.workers()).toEqual({ workerA: "recent-worker" });
    });

    test("can forceClean a worker, returning the error payload", async () => {
      await seedActiveWorker(
        queue,
        "workerA",
        "force-clean",
        [{ a: 1 }],
        new Date(),
      );
      const failure = await queue.forceCleanWorker("workerA");
      expect(failure?.worker).toBe("workerA");
      expect(failure?.queue).toBe("force-clean");
      expect(failure?.payload.args).toEqual([{ a: 1 }]);
      expect(failure?.backtrace[1]).toBe("queue#forceCleanWorker");
    });

    test("can forceClean a worker, returning the error payload and removing all keys it had set in redis", async () => {
      const id = await seedActiveWorker(
        queue,
        "workerA",
        "force-clean-keys",
        [],
        new Date(),
      );
      await queue.forceCleanWorker("workerA");
      expect(await queue.workers()).toEqual({});
      expect(await queue.workingOn("workerA", "force-clean-keys")).toBeNull();
      expect((await queue.failed(0, -1))[0]?.id).toBe(id);
    });

    test("forceCleanWorker emits an error for an unknown worker", async () => {
      const error = new Promise<Error>((resolve) => {
        queue.once("error", resolve);
      });
      expect(await queue.forceCleanWorker("missing-worker")).toBeUndefined();
      expect((await error).message).toContain("cannot find queues");
    });

    test("retryStuckJobs", async () => {
      await seedActiveWorker(queue, "workerA", "retry-one", [1], new Date());
      await queue.forceCleanWorker("workerA");
      await seedActiveWorker(queue, "workerB", "retry-two", [2], new Date());
      await queue.forceCleanWorker("workerB");

      await queue.retryStuckJobs(1);
      expect(await queue.failedCount()).toBe(1);
      expect(
        (await queue.length("retry-one")) + (await queue.length("retry-two")),
      ).toBe(1);
      await queue.retryStuckJobs(0);
      expect(await queue.failedCount()).toBe(1);
    });
  });
});
