import * as path from "node:path";
import {
  type LionDenPlugin,
  type NetworkHookHandlers,
  type ConfigHookHandlers,
  type ConfigValidationError,
  ArgumentType,
  task,
} from "@lionden/core";
import type { LionDenResolvedConfig } from "@lionden/config";
import { NetworkManagerImpl, DevnodeManager } from "@lionden/network";

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
    }

    return errors;
  },
};

// ---------------------------------------------------------------------------
// Network hooks
// ---------------------------------------------------------------------------

const networkHooks: NetworkHookHandlers = {};

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
  .addOption({
    name: "network",
    type: "string",
    description: "Aleo network (testnet, mainnet, canary)",
    defaultValue: "testnet",
  })
  .setAction(async (args, lre) => {
    const port = args["port"] as number;
    const manualBlocks = args["manualBlocks"] as boolean;
    const network = args["network"] as "testnet" | "mainnet" | "canary";

    const socketAddr = `127.0.0.1:${port}`;

    const devnode = new DevnodeManager();

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log("\nStopping devnode...");
      await devnode.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    console.log(`Starting devnode at http://${socketAddr}...`);

    // Resolve consensusHeights: prefer default network if devnode, else first devnode
    const defaultNet = lre.config.networks[lre.config.defaultNetwork];
    const devnodeNet =
      defaultNet?.type === "devnode"
        ? defaultNet
        : Object.values(lre.config.networks).find((n) => n.type === "devnode");
    const consensusHeights =
      devnodeNet?.type === "devnode" ? devnodeNet.consensusHeights : undefined;

    await devnode.start({
      socketAddr,
      autoBlock: !manualBlocks,
      network,
      leoBinary: lre.config.leoBinary,
      consensusHeights,
    });

    console.log(`Devnode running at ${devnode.endpoint}`);
    if (manualBlocks) {
      console.log("Manual block mode: use `leo devnode advance` to create blocks");
    }
    console.log("Press Ctrl-C to stop\n");

    // Keep the process alive
    await new Promise<void>(() => {
      // Never resolves — runs until SIGINT/SIGTERM
    });
  })
  .build();

const runTask = task("run", "Execute a TypeScript script with LRE context")
  .addPositionalArgument({
    name: "script",
    type: ArgumentType.FILE,
    description: "Path to the script file",
    required: true,
  })
  .addOption({
    name: "network",
    type: "string",
    description: "Network to connect to (overrides default)",
  })
  .setAction(async (args, lre) => {
    // Positional arg is passed via _positional array from CLI parser
    const positionals = args["_positional"] as string[] | undefined;
    const scriptPath = positionals?.[0] ?? (args["script"] as string | undefined);

    if (!scriptPath) {
      throw new Error(
        "Script path is required. Usage: lionden run <script> [--network <name>]",
      );
    }

    const networkName = args["network"] as string | undefined;

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
    network: networkHooks,
  },
  tasks: [nodeTask, runTask],

  extendLre(lre) {
    (lre as unknown as Record<string, unknown>)["network"] = new NetworkManagerImpl(lre.config);
  },
};

export default pluginNetwork;
