import * as fs from "node:fs";
import * as path from "node:path";
import type { LionDenResolvedConfig } from "@lionden/config";
import { HookDispatcherImpl } from "./hook-system.js";
import { TaskRunnerImpl } from "./task-runner.js";
import type {
  ArtifactStore,
  LionDenPlugin,
  LionDenRuntimeEnvironment,
  TaskDefinition,
} from "./types.js";

/**
 * Artifact store backed by in-memory writes with lazy fallback to disk.
 *
 * Fresh LRE instances are created inside test workers and CLI subprocesses.
 * They need to be able to observe artifacts produced by an earlier compile
 * step in a different process.
 */
class ArtifactStoreImpl implements ArtifactStore {
  private readonly artifactsDir: string;
  private readonly abis = new Map<string, unknown>();
  private readonly sources = new Map<string, string>();

  constructor(artifactsDir: string) {
    this.artifactsDir = artifactsDir;
  }

  setAbi(programId: string, abi: unknown): void {
    this.abis.set(programId, abi);
  }

  setAleoSource(programId: string, source: string): void {
    this.sources.set(programId, source);
  }

  getAbi(programId: string): unknown | undefined {
    const cached = this.abis.get(programId);
    if (cached !== undefined) {
      return cached;
    }

    const abiPath = path.join(this.artifactsDir, programId, "abi.json");
    if (!fs.existsSync(abiPath)) {
      return undefined;
    }

    const abi = JSON.parse(fs.readFileSync(abiPath, "utf8")) as unknown;
    this.abis.set(programId, abi);
    return abi;
  }

  getAleoSource(programId: string): string | undefined {
    const cached = this.sources.get(programId);
    if (cached !== undefined) {
      return cached;
    }

    const sourcePath = path.join(this.artifactsDir, programId, "main.aleo");
    if (!fs.existsSync(sourcePath)) {
      return undefined;
    }

    const source = fs.readFileSync(sourcePath, "utf8");
    this.sources.set(programId, source);
    return source;
  }

  getProgramIds(): string[] {
    const programIds = new Set(this.abis.keys());

    if (fs.existsSync(this.artifactsDir)) {
      for (const entry of fs.readdirSync(this.artifactsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
          continue;
        }

        const abiPath = path.join(this.artifactsDir, entry.name, "abi.json");
        if (fs.existsSync(abiPath)) {
          programIds.add(entry.name);
        }
      }
    }

    return [...programIds];
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
  const artifacts = new ArtifactStoreImpl(config.paths.artifacts);

  const lre: LionDenRuntimeEnvironment = {
    config,
    network: null, // Set by @lionden/plugin-network via extendLre
    deployments: null, // Set by @lionden/plugin-deploy via extendLre
    tasks,
    hooks,
    artifacts,
    plugins,
    globalOptions,
    namedAccounts: {}, // Overridden by @lionden/plugin-network via extendLre getter
  };

  // Allow plugins to inject services (e.g., network manager).
  //
  // NOTE: `globalOptions` may not be populated yet at this point. The CLI boot
  // path (packages/cli/src/index.ts) constructs the LRE with an empty
  // globalOptions object and fills it (by reference) only after a task-aware
  // argv parse — so the parse can decide whether `--prove` is a task flag or a
  // global. Plugins must therefore read CLI global option values lazily during
  // task execution, not synchronously here in extendLre.
  for (const plugin of plugins) {
    if (plugin.extendLre) {
      plugin.extendLre(lre);
    }
  }

  // Bind LRE to task runner
  tasks.setLre(lre);

  return lre;
}
