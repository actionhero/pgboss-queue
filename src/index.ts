/**
 * pgboss-queue — node-resque runtime model on PostgreSQL via pg-boss.
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
export { Plugin } from "./core/plugin.js";
export {
  type ParsedFailedJobPayload,
  type ParsedJob,
  type ParsedWorkerPayload,
  Queue,
} from "./core/queue.js";
export type { ErrorPayload } from "./types/errorPayload.js";
export type {
  Job,
  JobDefinition,
  Jobs,
  PluginConstructor,
} from "./types/job.js";
