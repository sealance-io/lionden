import * as path from "node:path";
import type {
  LionDenUserConfig,
  LionDenResolvedConfig,
  ResolvedCompilerConfig,
  ResolvedCodegenConfig,
  ResolvedTestingConfig,
  ResolvedDeployConfig,
  ResolvedPaths,
  ResolvedNetworkConfig,
  NetworkUserConfig,
  ConfigVariable,
} from "@lionden/config";
import { isConfigVariable, resolveConfigVariable } from "@lionden/config";
import type { LionDenPlugin, ConfigValidationError } from "./types.js";

export class ConfigResolutionError extends Error {
  constructor(
    message: string,
    public readonly errors: ConfigValidationError[],
  ) {
    super(message);
    this.name = "ConfigResolutionError";
  }
}

/**
 * Resolve user config through the full 4-stage lifecycle:
 *   1. extendUserConfig (waterfall per plugin)
 *   2. validateUserConfig (collect errors)
 *   3. resolveConfig (per plugin, merge partials)
 *   4. validateResolvedConfig (collect errors)
 */
export interface ResolveConfigResult {
  resolved: LionDenResolvedConfig;
  /** The user config after all extendUserConfig hooks have run */
  extendedUserConfig: LionDenUserConfig;
}

export async function resolveConfig(
  userConfig: LionDenUserConfig,
  plugins: readonly LionDenPlugin[],
  projectRoot: string,
): Promise<ResolveConfigResult> {
  // Resolve all config hook handlers from plugins upfront
  const configHandlers = await getConfigHookHandlers(plugins);

  // 1. Extend user config (waterfall)
  let config = userConfig;
  for (const handler of configHandlers) {
    if (handler.extendUserConfig) {
      config = await handler.extendUserConfig(config);
    }
  }

  // 2. Validate user config
  const userErrors = await collectValidationErrorsFromHandlers(
    configHandlers,
    "validateUserConfig",
    config,
  );
  if (userErrors.length > 0) {
    throw new ConfigResolutionError(
      `Config validation failed:\n${formatErrors(userErrors)}`,
      userErrors,
    );
  }

  // 3. Resolve: build the resolved config from defaults + plugin partials
  const resolvedVariable = async (v: ConfigVariable): Promise<string> => {
    return resolveConfigVariable(v);
  };

  // Start with defaults
  let resolved = buildDefaults(config, projectRoot);

  // Let plugins contribute their partial resolutions
  const partials: Partial<LionDenResolvedConfig>[] = [];
  for (const handler of configHandlers) {
    if (handler.resolveConfig) {
      const partial = await handler.resolveConfig(config, resolvedVariable);
      partials.push(partial);
    }
  }

  // Merge partials into resolved
  for (const partial of partials) {
    resolved = mergePartial(resolved, partial);
  }

  // 4. Validate resolved config
  const resolvedErrors = await collectValidationErrorsFromHandlers(
    configHandlers,
    "validateResolvedConfig",
    resolved,
  );
  if (resolvedErrors.length > 0) {
    throw new ConfigResolutionError(
      `Resolved config validation failed:\n${formatErrors(resolvedErrors)}`,
      resolvedErrors,
    );
  }

  return { resolved, extendedUserConfig: config };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConfigHookHandlers(
  plugins: readonly LionDenPlugin[],
): Promise<import("./types.js").ConfigHookHandlers[]> {
  const handlers: import("./types.js").ConfigHookHandlers[] = [];

  for (const plugin of plugins) {
    const configHandlers = plugin.hookHandlers?.config;
    if (!configHandlers) continue;

    if (typeof configHandlers === "function") {
      const resolved = await configHandlers();
      handlers.push(resolved);
    } else {
      handlers.push(configHandlers);
    }
  }

  return handlers;
}

async function collectValidationErrorsFromHandlers(
  handlers: import("./types.js").ConfigHookHandlers[],
  hookName: "validateUserConfig" | "validateResolvedConfig",
  config: unknown,
): Promise<ConfigValidationError[]> {
  const allErrors: ConfigValidationError[] = [];

  for (const handler of handlers) {
    const fn = handler[hookName];
    if (typeof fn === "function") {
      const errors = await fn(config as never);
      if (Array.isArray(errors)) {
        allErrors.push(...errors);
      }
    }
  }

  return allErrors;
}

function formatErrors(errors: ConfigValidationError[]): string {
  return errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
}

function buildDefaults(
  config: LionDenUserConfig,
  projectRoot: string,
): LionDenResolvedConfig {
  const programsDir = config.programsDir ?? "programs";
  const artifactsDir = config.artifactsDir ?? "artifacts";
  const typechainDir = config.typechainDir ?? "typechain";
  // codegen.outDir takes precedence over typechainDir when explicitly set
  const codegenOutDir = config.codegen?.outDir ?? typechainDir;

  const paths: ResolvedPaths = {
    root: projectRoot,
    programs: path.resolve(projectRoot, programsDir),
    artifacts: path.resolve(projectRoot, artifactsDir),
    typechain: path.resolve(projectRoot, codegenOutDir),
    cache: path.resolve(projectRoot, artifactsDir, ".cache"),
  };

  const compiler: ResolvedCompilerConfig = {
    enableDce: config.compiler?.enableDce ?? true,
    conditionalBlockMaxDepth: config.compiler?.conditionalBlockMaxDepth ?? 10,
    buildTests: config.compiler?.buildTests ?? false,
    extraFlags: config.compiler?.extraFlags ?? [],
  };

  const codegen: ResolvedCodegenConfig = {
    enabled: config.codegen?.enabled ?? true,
    outDir: codegenOutDir,
  };

  const testing: ResolvedTestingConfig = {
    framework: config.testing?.framework ?? "vitest",
    timeout: config.testing?.timeout ?? 120_000,
    autoStartDevnode: config.testing?.autoStartDevnode ?? true,
  };

  const deploy: ResolvedDeployConfig = {
    defaultPriorityFee: config.deploy?.defaultPriorityFee ?? 0,
    privateFee: config.deploy?.privateFee ?? false,
    confirmTransactions: config.deploy?.confirmTransactions ?? true,
    confirmationTimeout: config.deploy?.confirmationTimeout ?? 60_000,
  };

  // Resolve networks
  const networks: Record<string, ResolvedNetworkConfig> = {};
  const userNetworks = config.networks ?? {};

  // Always provide a default devnode network if none specified
  if (Object.keys(userNetworks).length === 0) {
    networks["devnode"] = {
      type: "devnode",
      socketAddr: "127.0.0.1:3030",
      autoBlock: true,
      verbosity: 0,
      accounts: [],
      network: "testnet",
    };
  } else {
    for (const [name, netConfig] of Object.entries(userNetworks)) {
      networks[name] = resolveNetworkConfig(name, netConfig);
    }
  }

  const defaultNetwork = config.defaultNetwork ?? "devnode";

  return {
    leoVersion: config.leoVersion ?? "4.0.0",
    paths,
    networks,
    defaultNetwork,
    compiler,
    codegen,
    testing,
    deploy,
  };
}

function resolveNetworkConfig(
  networkName: string,
  config: NetworkUserConfig,
): ResolvedNetworkConfig {
  switch (config.type) {
    case "devnode":
      return {
        type: "devnode",
        socketAddr: config.socketAddr ?? "127.0.0.1:3030",
        autoBlock: config.autoBlock ?? true,
        verbosity: config.verbosity ?? 0,
        accounts: (config.accounts ?? []).map((a, i) => {
          const key = resolveStringOrVariable(a.privateKey);
          if (!key) {
            const err = {
              path: `networks.${networkName}.accounts[${i}].privateKey`,
              message: "Account private key must be a non-empty string or a resolvable ConfigVariable",
            };
            throw new ConfigResolutionError(err.message, [err]);
          }
          return { privateKey: key, name: a.name };
        }),
        genesisPath: config.genesisPath,
        network: config.network ?? "testnet",
      };
    case "devnet":
      return {
        type: "devnet",
        numValidators: config.numValidators ?? 4,
        numClients: config.numClients ?? 2,
        network: config.network ?? "testnet",
        snarkosPath: config.snarkosPath ?? "snarkos",
        verbosity: config.verbosity ?? 1,
        restPort: config.restPort ?? 3030,
        storageDir: config.storageDir,
      };
    case "http":
      return {
        type: "http",
        endpoint: config.endpoint,
        network: config.network,
        privateKey: resolveStringOrVariable(config.privateKey),
        apiKey: resolveStringOrVariable(config.apiKey),
      };
  }
}

function resolveStringOrVariable(
  value: string | ConfigVariable | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (isConfigVariable(value)) return resolveConfigVariable(value);
  return undefined;
}

function mergePartial(
  base: LionDenResolvedConfig,
  partial: Partial<LionDenResolvedConfig>,
): LionDenResolvedConfig {
  return {
    ...base,
    ...partial,
    paths: { ...base.paths, ...(partial.paths ?? {}) },
    compiler: {
      ...base.compiler,
      ...(partial.compiler ?? {}),
    },
    codegen: { ...base.codegen, ...(partial.codegen ?? {}) },
    testing: { ...base.testing, ...(partial.testing ?? {}) },
    deploy: { ...base.deploy, ...(partial.deploy ?? {}) },
    networks: { ...base.networks, ...(partial.networks ?? {}) },
  } as LionDenResolvedConfig;
}
