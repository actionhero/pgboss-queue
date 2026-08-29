import {
  type JobDefinition,
  type Jobs,
  jobDefinition,
  type PluginConstructor,
  type PluginHost,
} from "../types/job.js";
import type { Plugin } from "./plugin.js";

/** Hook names understood by the plugin runner. */
export type PluginHook =
  | "beforeEnqueue"
  | "afterEnqueue"
  | "beforePerform"
  | "afterPerform";

/**
 * Run all plugins for one job in declaration order.
 *
 * @param self - Queue or Worker invoking the plugins.
 * @param type - Hook to invoke.
 * @param func - Registered job name.
 * @param queue - Queue name.
 * @param job - Job declaration, including function-form jobs.
 * @param args - Job arguments.
 * @returns `false` when a plugin vetoes the operation, otherwise `true`.
 */
export async function runPlugins(
  self: PluginHost,
  type: PluginHook,
  func: string,
  queue: string,
  job: Jobs[string] | undefined,
  args: unknown[],
): Promise<boolean> {
  const definition = jobDefinition(job);
  if (!definition?.plugins?.length) return true;

  for (const reference of definition.plugins) {
    const result = await runPlugin(
      self,
      reference,
      type,
      func,
      queue,
      definition,
      args,
    );
    if (result === false) return false;
  }

  return true;
}

/**
 * Construct and run one plugin hook.
 *
 * @param self - Queue or Worker invoking the plugin.
 * @param reference - Plugin constructor or built-in plugin name.
 * @param type - Hook to invoke.
 * @param func - Registered job name.
 * @param queue - Queue name.
 * @param job - Normalized job definition.
 * @param args - Job arguments.
 * @returns Hook result, defaulting to `true` when the hook is absent.
 * @throws If a named plugin module does not export the requested plugin.
 */
export async function runPlugin(
  self: PluginHost,
  reference: string | PluginConstructor,
  type: PluginHook,
  func: string,
  queue: string,
  job: JobDefinition,
  args: unknown[],
): Promise<boolean> {
  const Constructor =
    typeof reference === "string"
      ? await loadNamedPlugin(reference)
      : reference;

  const name = Constructor.name || "Node Resque Plugin";
  const options = job.pluginOptions?.[name] ?? {};
  const plugin = new Constructor(self, func, queue, job, args, options);
  const hook = plugin[type];
  if (typeof hook !== "function") return true;

  return (await hook.call(plugin)) !== false;
}

async function loadNamedPlugin(name: string): Promise<PluginConstructor> {
  const module: unknown = await import(`../plugins/${name}.js`);
  if (!isModuleRecord(module)) {
    throw new Error(`Plugin module "${name}" is invalid`);
  }

  const Constructor = module[name];
  if (typeof Constructor !== "function") {
    throw new Error(`Plugin "${name}" is not exported`);
  }

  return Constructor as PluginConstructor;
}

function isModuleRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** @deprecated Use {@link runPlugins}. Kept for node-resque source compatibility. */
export const RunPlugins = runPlugins;

/** @deprecated Use {@link runPlugin}. Kept for node-resque source compatibility. */
export const RunPlugin = runPlugin;

// Assert the indexed hook surface remains compatible with Plugin.
const _pluginTypeCheck: PluginHook[] = [
  "beforeEnqueue",
  "afterEnqueue",
  "beforePerform",
  "afterPerform",
];
void (_pluginTypeCheck satisfies Array<keyof Plugin>);
