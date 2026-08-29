import type { Plugin } from "../core/plugin.js";

/** A job implementation registered by name. */
export interface JobDefinition {
  /** Plugins run in declaration order around enqueue and perform operations. */
  plugins?: Array<string | PluginConstructor>;
  /** Options keyed by plugin class name. */
  pluginOptions?: Record<string, Record<string, unknown>>;
  /** Execute the job with its encoded arguments. */
  perform: (...args: unknown[]) => unknown | Promise<unknown>;
}

/** Constructor shape accepted in a job's `plugins` list. */
export type PluginConstructor = new (
  worker: PluginHost,
  func: string,
  queue: string,
  job: JobDefinition,
  args: unknown[],
  options: Record<string, unknown>,
) => Plugin;

/** Minimal host surface needed by plugin instances. */
export interface PluginHost {
  jobs: Jobs;
}

/** Function-form jobs are shorthand for `{ perform: fn }`. */
export type Job = JobDefinition | JobDefinition["perform"];

/** Named job registry supplied to Queue and Worker. */
export interface Jobs {
  [jobName: string]: Job;
}

/** Normalize either supported job declaration into an object definition. */
export function jobDefinition(job: Job | undefined): JobDefinition | undefined {
  return typeof job === "function" ? { perform: job } : job;
}
