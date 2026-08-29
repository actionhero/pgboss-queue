import type { JobDefinition, PluginHost } from "../types/job.js";
import type { Queue } from "./queue.js";

/**
 * Base class for node-resque-compatible job plugins.
 *
 * Subclasses may implement any enqueue/perform hook. Returning `false` from a
 * before hook prevents the operation.
 */
export abstract class Plugin {
  /** Plugin name used to look up `pluginOptions`. */
  readonly name: string;
  /** Queue or Worker instance invoking this plugin. */
  readonly worker: PluginHost;
  /** Queue instance associated with the host, when available. */
  readonly queueObject: Queue | undefined;
  /** Queue name for this operation. */
  readonly queue: string;
  /** Registered job name. */
  readonly func: string;
  /** Registered job definition. */
  readonly job: JobDefinition;
  /** Arguments encoded for the job. */
  readonly args: unknown[];
  /** Options selected by plugin name. */
  readonly options: Record<string, unknown>;

  /**
   * @param worker - Queue or Worker invoking the hook.
   * @param func - Registered job name.
   * @param queue - Queue name for this operation.
   * @param job - Registered job definition.
   * @param args - Job arguments.
   * @param options - Plugin-specific options.
   */
  constructor(
    worker: PluginHost,
    func: string,
    queue: string,
    job: JobDefinition,
    args: unknown[],
    options: Record<string, unknown>,
  ) {
    this.name = this.constructor.name || "Node Resque Plugin";
    this.worker = worker;
    this.func = func;
    this.queue = queue;
    this.job = job;
    this.args = args;
    this.options = options;

    const host = worker as PluginHost & { queueObject?: Queue };
    this.queueObject =
      host.queueObject ?? (isQueue(worker) ? worker : undefined);
  }

  /** Run before enqueue. Return `false` to suppress enqueueing. */
  beforeEnqueue?(): boolean | Promise<boolean>;
  /** Run after enqueue. */
  afterEnqueue?(): boolean | Promise<boolean>;
  /** Run before performing. Return `false` to suppress execution. */
  beforePerform?(): boolean | Promise<boolean>;
  /** Run after performing. */
  afterPerform?(): boolean | Promise<boolean>;
}

function isQueue(host: PluginHost): host is Queue {
  return "enqueue" in host;
}
