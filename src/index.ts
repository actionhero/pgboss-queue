/**
 * pgboss-queue — node-resque runtime model on PostgreSQL via pg-boss.
 *
 * Phase 2 exports {@link Connection}. Queue / Worker / Scheduler arrive in later phases.
 */
export {
  assertSchema,
  Connection,
  type ConnectionOptions,
  type MultiWorkerOptions,
  type QueueOptions,
  type SchedulerOptions,
  type WorkerOptions,
} from "./core/connection.js";
