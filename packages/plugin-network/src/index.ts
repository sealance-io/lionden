import * as path from "node:path";
import type { LionDenResolvedConfig } from "@lionden/config";
import {
  ArgumentType,
  type ConfigHookHandlers,
  type ConfigValidationError,
  type LionDenPlugin,
  task,
} from "@lionden/core";
import {
  DevnodeManager,
  NetworkManagerImpl,
  preflightDevnode,
  resolveDevnodeBackend,
} from "@lionden/network";

// ---------------------------------------------------------------------------
// Config hooks
// ---------------------------------------------------------------------------

const configHooks: ConfigHookHandlers = {
  validateResolvedConfig(config: LionDenResolvedConfig): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];

    // Validate that the default network exists
    if (!config.networks[config.defaultNetwork]) {
      errors.push({
        path: "defaultNetwork",
        message: `Default network "${config.defaultNetwork}" is not defined in networks config`,
      });
    }

    // Validate HTTP networks have required fields
    for (const [name, net] of Object.entries(config.networks)) {
      if (net.type === "http") {
        if (!net.endpoint) {
          errors.push({
            path: `networks.${name}.endpoint`,
            message: `HTTP network "${name}" must specify an endpoint URL`,
          });
        }
      }
      if (net.type === "devnode") {
        // --clear-storage requires --storage on every backend.
        if (net.clearStorageOnStart && !net.storagePath) {
          errors.push({
            path: `networks.${name}.clearStorageOnStart`,
            message: `Devnode network "${name}" sets clearStorageOnStart but no storagePath; clearing storage requires a storage directory.`,
          });
        }
        // Standalone is TestnetV0-only and has consensus heights compiled in.
        // Auto-detected standalone (provider undefined) is checked at start time.
        if (net.provider === "standalone") {
          if (net.network !== "testnet") {
            errors.push({
              path: `networks.${name}.network`,
              message: `Devnode network "${name}" uses provider "standalone", which only supports network "testnet" (got "${net.network}").`,
            });
          }
          if (net.consensusHeights !== undefined) {
            errors.push({
              path: `networks.${name}.consensusHeights`,
              message: `Devnode network "${name}" uses provider "standalone", which does not support consensusHeights (they are compiled into aleo-devnode).`,
            });
          }
        }
      }
    }

    return errors;
  },
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const nodeTask = task("node", "Start a local Aleo devnode")
  .addOption({
    name: "port",
    type: "number",
    description: "REST API port",
    defaultValue: 3030,
  })
  .addFlag({ name: "manualBlocks", description: "Disable automatic block creation" })
  .addFlag({ name: "quiet", description: "Suppress devnode log output" })
  .addOption({
    name: "persist",
    type: "string",
    description: "Persist the ledger to this directory (standalone aleo-devnode only)",
  })
  .addFlag({
    name: "clearStorage",
    description: "Clear the persist directory before starting (requires --persist)",
  })
  .setAction(async (args, lre) => {
    const port = args.port as number;
    const manualBlocks = args.manualBlocks as boolean;
    const quiet = args.quiet as boolean;
    const persist = args.persist as string | undefined;
    const clearStorage = args.clearStorage as boolean;

    if (clearStorage && !persist) {
      throw new Error("--clear-storage requires --persist <dir>.");
    }

    const socketAddr = `127.0.0.1:${port}`;

    // Resolve the devnode network config: prefer default network if devnode,
    // else first devnode found.
    const defaultNet = lre.config.networks[lre.config.defaultNetwork];
    const devnodeNet =
      defaultNet?.type === "devnode"
        ? defaultNet
        : Object.values(lre.config.networks).find((n) => n.type === "devnode");
    const network = devnodeNet?.network;
    const consensusHeights =
      devnodeNet?.type === "devnode" ? devnodeNet.consensusHeights : undefined;
    const storagePath =
      persist ?? (devnodeNet?.type === "devnode" ? devnodeNet.storagePath : undefined);
    const clearStorageOnStart =
      clearStorage || (devnodeNet?.type === "devnode" ? devnodeNet.clearStorageOnStart : false);

    const backend = await resolveDevnodeBackend({
      provider: devnodeNet?.type === "devnode" ? devnodeNet.provider : undefined,
      leoBinary: lre.config.leoBinary,
      binary: devnodeNet?.type === "devnode" ? devnodeNet.binary : undefined,
      network,
      consensusHeights,
      requiresPersistence: storagePath !== undefined,
    });

    await preflightDevnode(lre.config, backend);

    const devnode = new DevnodeManager();

    // Handle graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("\nStopping devnode...");
      await devnode.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    console.log(
      `Starting ${backend.provider} devnode at http://${socketAddr}...` +
        (storagePath ? ` (persisting to ${storagePath})` : ""),
    );

    await devnode.start({
      socketAddr,
      autoBlock: !manualBlocks,
      network,
      provider: backend.provider,
      leoBinary: lre.config.leoBinary,
      devnodeBinary: backend.command,
      // consensusHeights is leo-only; resolveDevnodeBackend already rejected it
      // for standalone, so it's safe to forward unconditionally.
      consensusHeights,
      ...(storagePath ? { storagePath } : {}),
      ...(clearStorageOnStart ? { clearStorage: true } : {}),
      logMode: quiet ? "quiet-buffered" : "inherit",
    });

    console.log(`Devnode running at ${devnode.endpoint}`);
    if (manualBlocks) {
      const advanceHint =
        backend.provider === "standalone" ? "aleo-devnode advance" : "leo devnode advance";
      console.log(`Manual block mode: use \`${advanceHint}\` to create blocks`);
    }
    console.log("Press Ctrl-C to stop\n");

    const exit = await devnode.waitForExit();
    // The SIGINT/SIGTERM shutdown handler calls process.exit(0) before we
    // reach here, so this branch only runs on an unexpected devnode exit.
    // Treat both non-zero codes and signal-only exits (e.g. SIGKILL →
    // { code: null, signal: "SIGKILL" }) as failure.
    const cleanExit = exit.code === 0 && exit.signal === null;
    process.exit(cleanExit ? 0 : 1);
  })
  .build();

const runTask = task("run", "Execute a TypeScript script with LRE context")
  .addPositionalArgument({
    name: "script",
    type: ArgumentType.FILE,
    description: "Path to the script file",
    required: true,
  })
  .setAction(async (args, lre) => {
    // Positional arg is passed via _positional array from CLI parser
    const positionals = args._positional as string[] | undefined;
    const scriptPath = positionals?.[0] ?? (args.script as string | undefined);

    if (!scriptPath) {
      throw new Error("Script path is required. Usage: lionden run <script>");
    }

    const networkName = (args.network as string) ?? lre.config.defaultNetwork;

    // Connect to the specified or default network
    const manager = lre.network as NetworkManagerImpl;
    if (manager && typeof manager.connect === "function") {
      await manager.connect(networkName);
    }

    // Resolve the script path relative to project root
    const absolutePath = path.isAbsolute(scriptPath)
      ? scriptPath
      : path.resolve(lre.config.paths.root, scriptPath);

    // Import and execute the script.
    // The CLI must be invoked via tsx (or node --import tsx) for .ts support.
    const scriptModule = (await import(absolutePath)) as Record<string, unknown>;

    if (typeof scriptModule["default"] === "function") {
      return await (scriptModule["default"] as (lre: unknown) => Promise<unknown>)(lre);
    } else if (typeof scriptModule["main"] === "function") {
      return await (scriptModule["main"] as (lre: unknown) => Promise<unknown>)(lre);
    }

    // Script ran via side effects on import
  })
  .build();

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const pluginNetwork: LionDenPlugin = {
  id: "@lionden/plugin-network",
  name: "Network Plugin",
  hookHandlers: {
    config: configHooks,
  },
  tasks: [nodeTask, runTask],

  extendLre(lre) {
    const manager = new NetworkManagerImpl(lre.config);
    (lre as unknown as Record<string, unknown>)["network"] = manager;
    // Override the stub namedAccounts: {} with a live getter backed by the manager.
    // This ensures lre.namedAccounts always reflects the current active network.
    Object.defineProperty(lre, "namedAccounts", {
      get: () => manager.getNamedAccounts(),
      enumerable: true,
      configurable: true,
    });
  },
};

export default pluginNetwork;
