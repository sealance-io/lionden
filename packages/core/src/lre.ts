import type { LionDenResolvedConfig } from "@lionden/config";
import type {
  LionDenPlugin,
  LionDenRuntimeEnvironment,
  ArtifactStore,
  TaskDefinition,
} from "./types.js";
import { HookDispatcherImpl } from "./hook-system.js";
import { TaskRunnerImpl } from "./task-runner.js";

/**
 * In-memory artifact store. Populated by the compile task.
 */
class InMemoryArtifactStore implements ArtifactStore {
  private readonly abis = new Map<string, unknown>();
  private readonly sources = new Map<string, string>();

  setAbi(programId: string, abi: unknown): void {
    this.abis.set(programId, abi);
  }

  setAleoSource(programId: string, source: string): void {
    this.sources.set(programId, source);
  }

  getAbi(programId: string): unknown | undefined {
    return this.abis.get(programId);
  }

  getAleoSource(programId: string): string | undefined {
    return this.sources.get(programId);
  }

  getProgramIds(): string[] {
    return [...this.abis.keys()];
  }
}

export interface CreateLreOptions {
  config: LionDenResolvedConfig;
  plugins: readonly LionDenPlugin[];
  globalOptions?: Record<string, unknown>;
  /** Tasks registered at the config level (via defineConfig({ tasks })) */
  configTasks?: readonly TaskDefinition[];
}

/**
 * Construct the LionDen Runtime Environment.
 */
export function createLre(options: CreateLreOptions): LionDenRuntimeEnvironment {
  const { config, plugins, globalOptions = {}, configTasks = [] } = options;

  // Build hook dispatcher
  const hooks = new HookDispatcherImpl();
  hooks.registerPlugins(plugins);

  // Build task runner
  const tasks = new TaskRunnerImpl();

  // Register tasks from all plugins, then config-level tasks
  const allTaskDefs = plugins.flatMap((p) => p.tasks ?? []);
  tasks.registerTasks(allTaskDefs);
  if (configTasks.length > 0) {
    tasks.registerTasks(configTasks);
  }

  // Build artifact store
  const artifacts = new InMemoryArtifactStore();

  const lre: LionDenRuntimeEnvironment = {
    config,
    network: null, // Set by @lionden/plugin-network via extendLre
    tasks,
    hooks,
    artifacts,
    plugins,
    globalOptions,
  };

  // Allow plugins to inject services (e.g., network manager)
  for (const plugin of plugins) {
    if (plugin.extendLre) {
      plugin.extendLre(lre);
    }
  }

  // Bind LRE to task runner
  tasks.setLre(lre);

  return lre;
}
