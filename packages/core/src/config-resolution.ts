import * as os from "node:os";
import * as path from "node:path";
import type {
  LionDenUserConfig,
  LionDenResolvedConfig,
  ResolvedCompilerConfig,
  ResolvedCodegenConfig,
  ResolvedDynamicRecordHelper,
  ResolvedTestingConfig,
  ResolvedDeployConfig,
  ResolvedSdkConfig,
  ResolvedSdkEgressConfig,
  ResolvedExecutionConfig,
  RuntimeImportRef,
  ResolvedPaths,
  ResolvedNetworkConfig,
  NetworkUserConfig,
  ConfigVariable,
  NamedAccountConfig,
  NamedAccountValue,
  ResolvedNamedAccountValue,
  ResolvedNamedAccountEntry,
  ResolvedNamedAccountsConfig,
} from "@lionden/config";
import {
  isConfigVariable,
  resolveConfigVariable,
  isValidAleoAddress,
  classifyRuntimeImportRef,
  normalizeRuntimeImportRef,
  isValidExecutionImportsMapKey,
  normalizeProgramId,
  checkRuntimeImportRefExists,
} from "@lionden/config";
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

  // 2. Validate user config (built-in core passes + plugin handlers)
  const userErrors = [
    ...validateExecutionUserConfig(config),
    ...(await collectValidationErrorsFromHandlers(
      configHandlers,
      "validateUserConfig",
      config,
    )),
  ];
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

  // 4. Validate resolved config (built-in core passes + plugin handlers)
  const resolvedErrors = [
    ...validateExecutionResolvedConfig(resolved),
    ...(await collectValidationErrorsFromHandlers(
      configHandlers,
      "validateResolvedConfig",
      resolved,
    )),
  ];
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
  const deploymentsDir = config.deploy?.deploymentsDir ?? "deployments";

  const paths: ResolvedPaths = {
    root: projectRoot,
    programs: path.resolve(projectRoot, programsDir),
    artifacts: path.resolve(projectRoot, artifactsDir),
    typechain: path.resolve(projectRoot, codegenOutDir),
    cache: path.resolve(projectRoot, artifactsDir, ".cache"),
    deployments: path.resolve(projectRoot, deploymentsDir),
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
    dynamicRecords: normalizeDynamicRecords(config.codegen?.dynamicRecords),
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
    deploymentsDir: deploymentsDir,
    skipDeployed: config.deploy?.skipDeployed ?? true,
    interDeploymentDelay: config.deploy?.interDeploymentDelay,
    autoExport: config.deploy?.autoExport ?? false,
  };

  const sdk: ResolvedSdkConfig = resolveSdkConfig(config, projectRoot, paths.artifacts);

  const execution: ResolvedExecutionConfig = resolveExecutionConfig(config, projectRoot);

  // Resolve networks
  const networks: Record<string, ResolvedNetworkConfig> = {};
  const userNetworks = config.networks ?? {};

  const deployEphemeral = config.deploy?.ephemeral;

  // Always provide a default devnode network if none specified
  if (Object.keys(userNetworks).length === 0) {
    networks["devnode"] = {
      type: "devnode",
      socketAddr: "127.0.0.1:3030",
      autoBlock: true,
      verbosity: 0,
      accounts: [],
      network: "testnet",
      ephemeral: deployEphemeral ?? true,
    };
  } else {
    for (const [name, netConfig] of Object.entries(userNetworks)) {
      networks[name] = resolveNetworkConfig(name, netConfig, deployEphemeral);
    }
  }

  const defaultNetwork = config.defaultNetwork ?? "devnode";

  const namedAccounts = resolveNamedAccountsConfig(config.namedAccounts ?? {});

  return {
    leoVersion: config.leoVersion ?? "4.0.0",
    skipLeoVersionCheck: config.skipLeoVersionCheck ?? false,
    leoBinary: expandTilde(config.leoBinary ?? "leo"),
    paths,
    networks,
    defaultNetwork,
    compiler,
    codegen,
    testing,
    deploy,
    sdk,
    execution,
    namedAccounts,
  };
}

function resolveSdkConfig(
  config: LionDenUserConfig,
  projectRoot: string,
  artifactsPath: string,
): ResolvedSdkConfig {
  const keyCache = config.sdk?.keyCache;
  const storage = keyCache?.storage ?? "filesystem";
  const egress = resolveSdkEgressConfig(config);

  if (storage === "memory") {
    return egress === undefined
      ? { keyCache: { storage } }
      : { keyCache: { storage }, egress };
  }

  const rawPath = keyCache?.path ?? path.join(artifactsPath, ".cache", "provable-keys");
  const expandedPath = expandTilde(rawPath);
  const absolutePath = path.isAbsolute(expandedPath)
    ? expandedPath
    : path.resolve(projectRoot, expandedPath);

  return egress === undefined
    ? {
        keyCache: {
          storage,
          path: normalizeAleoKeyCachePath(absolutePath),
        },
      }
    : {
        keyCache: {
          storage,
          path: normalizeAleoKeyCachePath(absolutePath),
        },
        egress,
      };
}

function resolveSdkEgressConfig(
  config: LionDenUserConfig,
): ResolvedSdkEgressConfig | undefined {
  const egress = config.sdk?.egress;
  if (!egress) return undefined;
  const resolved: {
    networkHosts?: readonly string[];
    violation?: "block" | "warn";
  } = {};
  if (egress.networkHosts) resolved.networkHosts = [...egress.networkHosts];
  if (egress.violation) resolved.violation = egress.violation;
  return resolved;
}

function normalizeAleoKeyCachePath(p: string): string {
  return path.basename(p) === ".aleo" ? p : path.join(p, ".aleo");
}

/**
 * Normalize the user-provided `dynamicRecords` map into the resolved form by
 * attaching each map key as `helperName`. Defensive against malformed input
 * (non-object map, non-object entries) — entries that don't look like helper
 * configs are dropped silently so the resolved shape stays stable. The
 * plugin-leo `validateUserConfig` hook is responsible for surfacing those
 * malformed entries as `ConfigValidationError` to the user before this
 * normalization is consumed by codegen.
 */
function normalizeDynamicRecords(
  raw: unknown,
): Readonly<Record<string, ResolvedDynamicRecordHelper>> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries: Array<[string, ResolvedDynamicRecordHelper]> = [];
  for (const [helperName, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
    const helper = value as Record<string, unknown>;
    const sourceRecord = helper["sourceRecord"];
    const schema = helper["schema"];
    if (typeof sourceRecord !== "string" || schema == null || typeof schema !== "object" || Array.isArray(schema)) {
      continue;
    }
    const normalizedSchema: Record<string, string> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      normalizedSchema[k] = v;
    }
    const sourceProgram = helper["sourceProgram"];
    entries.push([
      helperName,
      {
        helperName,
        sourceRecord,
        ...(typeof sourceProgram === "string" ? { sourceProgram } : {}),
        schema: normalizedSchema,
      },
    ]);
  }
  return Object.fromEntries(entries);
}

function resolveNetworkConfig(
  networkName: string,
  config: NetworkUserConfig,
  deployEphemeral?: boolean,
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
        privateKey: config.privateKey,
        consensusHeights: config.consensusHeights,
        ephemeral: config.ephemeral ?? deployEphemeral ?? true,
      };
    case "http":
      return {
        type: "http",
        endpoint: config.endpoint,
        network: config.network,
        privateKey: resolveStringOrVariable(config.privateKey),
        apiKey: resolveStringOrVariable(config.apiKey),
        ephemeral: config.ephemeral ?? deployEphemeral ?? false,
      };
    default: {
      const unknownType = (config as { type: string }).type;
      throw new ConfigResolutionError(
        `Unknown network type "${unknownType}" for network "${networkName}". Supported types are "devnode" and "http".`,
        [{
          path: `networks.${networkName}.type`,
          message: `Unknown network type "${unknownType}". Supported types are "devnode" and "http".`,
        }],
      );
    }
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

// ---------------------------------------------------------------------------
// Named accounts resolution
// ---------------------------------------------------------------------------

/**
 * Resolve user-provided namedAccounts config to the fully classified form.
 * This is synchronous — ConfigVariable values are resolved eagerly (existing
 * convention). Address derivation from private keys is deferred to runtime.
 *
 * Validation:
 * - Numeric index: must be a finite non-negative integer
 * - String starting with "aleo1": must pass full address shape validation
 * - String starting with "APrivateKey1": accepted as-is (private key)
 * - Other strings: config error
 */
function resolveNamedAccountsConfig(
  userNamedAccounts: Record<string, NamedAccountConfig>,
): ResolvedNamedAccountsConfig {
  const resolved: Record<string, ResolvedNamedAccountEntry> = {};

  for (const [accountName, accountConfig] of Object.entries(userNamedAccounts)) {
    const networks: Record<string, ResolvedNamedAccountValue> = {};

    for (const [key, value] of Object.entries(accountConfig)) {
      if (value === undefined) continue;

      const resolvedValue = resolveNamedAccountValue(accountName, key, value);
      if (key === "default") {
        // handled below via accountConfig.default
        continue;
      }
      networks[key] = resolvedValue;
    }

    const defaultValue =
      accountConfig.default !== undefined
        ? resolveNamedAccountValue(accountName, "default", accountConfig.default)
        : undefined;

    resolved[accountName] = { networks, default: defaultValue };
  }

  return resolved;
}

function resolveNamedAccountValue(
  accountName: string,
  keyName: string,
  value: NamedAccountValue,
): ResolvedNamedAccountValue {
  // Resolve ConfigVariable first
  let raw: string | number;
  if (typeof value === "number") {
    raw = value;
  } else if (typeof value === "string") {
    raw = value;
  } else if (isConfigVariable(value)) {
    const resolved = resolveConfigVariable(value);
    // After variable resolution, treat as string
    raw = resolved;
  } else {
    throw new ConfigResolutionError(
      `Named account "${accountName}" (${keyName}): unsupported value type.`,
      [{ path: `namedAccounts.${accountName}.${keyName}`, message: "Value must be a number, string, or ConfigVariable." }],
    );
  }

  if (typeof raw === "number") {
    // Validate: finite non-negative integer
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
      throw new ConfigResolutionError(
        `Named account "${accountName}" (${keyName}): index must be a non-negative integer, got ${raw}.`,
        [{
          path: `namedAccounts.${accountName}.${keyName}`,
          message: `Index must be a non-negative integer, got ${raw}.`,
        }],
      );
    }
    return { type: "index", index: raw };
  }

  // raw is a string
  if (raw.startsWith("aleo1")) {
    if (!isValidAleoAddress(raw)) {
      throw new ConfigResolutionError(
        `Named account "${accountName}" (${keyName}): "${raw}" looks like an Aleo address but has an invalid format. ` +
          `Expected "aleo1" followed by exactly 58 lowercase alphanumeric characters.`,
        [{
          path: `namedAccounts.${accountName}.${keyName}`,
          message: `Invalid Aleo address format. Expected "aleo1" + 58 lowercase alphanumeric chars.`,
        }],
      );
    }
    return { type: "address", address: raw };
  }

  if (raw.startsWith("APrivateKey1")) {
    return { type: "privateKey", privateKey: raw };
  }

  throw new ConfigResolutionError(
    `Named account "${accountName}" (${keyName}): string "${raw}" is not a recognized Aleo address (aleo1...) or private key (APrivateKey1...).`,
    [{
      path: `namedAccounts.${accountName}.${keyName}`,
      message: `Must be an Aleo address (aleo1...), a private key (APrivateKey1...), or a devnode account index (number).`,
    }],
  );
}

function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
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
    sdk: mergeSdkConfig(base.sdk, partial.sdk),
    execution: {
      imports: {
        ...base.execution.imports,
        ...(partial.execution?.imports ?? {}),
      },
    },
    networks: { ...base.networks, ...(partial.networks ?? {}) },
    namedAccounts: { ...base.namedAccounts, ...(partial.namedAccounts ?? {}) },
  } as LionDenResolvedConfig;
}

// ---------------------------------------------------------------------------
// Execution config (runtime imports for dynamic dispatch)
// ---------------------------------------------------------------------------

/**
 * Resolve `execution.imports` into normalized `RuntimeImportRef[]` keyed by
 * canonical `.aleo` program id. Invalid refs are skipped here — they would
 * have surfaced in `validateExecutionUserConfig`. Map keys collide-merge
 * after normalization (e.g. `governance` + `governance.aleo` → one entry).
 */
function resolveExecutionConfig(
  config: LionDenUserConfig,
  projectRoot: string,
): ResolvedExecutionConfig {
  const raw = config.execution?.imports;
  if (!raw || typeof raw !== "object") {
    return { imports: {} };
  }

  const byKey = new Map<string, RuntimeImportRef[]>();
  for (const [rawKey, refs] of Object.entries(raw)) {
    if (!isValidExecutionImportsMapKey(rawKey)) continue;
    if (!Array.isArray(refs)) continue;

    const canonicalKey = normalizeProgramId(rawKey);
    const refList = byKey.get(canonicalKey) ?? [];
    for (const raw of refs) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      if (classifyRuntimeImportRef(raw) === "invalid") continue;
      try {
        refList.push(normalizeRuntimeImportRef(raw, projectRoot));
      } catch {
        // Ignore — already filtered by classify above; defense in depth.
      }
    }
    byKey.set(canonicalKey, refList);
  }

  // Dedup and sort each list deterministically for cache identity stability.
  const result: Record<string, readonly RuntimeImportRef[]> = {};
  for (const [key, refs] of byKey) {
    result[key] = dedupAndSortRuntimeImports(refs);
  }
  return { imports: result };
}

function dedupAndSortRuntimeImports(
  refs: readonly RuntimeImportRef[],
): readonly RuntimeImportRef[] {
  const seen = new Set<string>();
  const out: RuntimeImportRef[] = [];
  for (const ref of refs) {
    const key = ref.kind === "programId" ? `id:${ref.programId}` : `path:${ref.absolutePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  out.sort((a, b) => {
    const aKey = a.kind === "programId" ? a.programId : a.absolutePath;
    const bKey = b.kind === "programId" ? b.programId : b.absolutePath;
    if (aKey === bKey) return 0;
    return aKey < bKey ? -1 : 1;
  });
  return out;
}

function validateExecutionUserConfig(
  config: LionDenUserConfig,
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];
  const imports = config.execution?.imports;
  if (imports === undefined) return errors;
  if (typeof imports !== "object" || imports === null || Array.isArray(imports)) {
    errors.push({
      path: "execution.imports",
      message: "Must be an object mapping program ids to import-ref arrays.",
    });
    return errors;
  }

  for (const [key, refs] of Object.entries(imports)) {
    if (!isValidExecutionImportsMapKey(key)) {
      errors.push({
        path: `execution.imports[${JSON.stringify(key)}]`,
        message: `Map keys must be Leo program ids (bare or .aleo). Got ${JSON.stringify(key)}.`,
      });
      continue;
    }
    if (!Array.isArray(refs)) {
      errors.push({
        path: `execution.imports[${JSON.stringify(key)}]`,
        message: "Value must be an array of program-id or path refs.",
      });
      continue;
    }
    if (refs.length === 0) {
      errors.push({
        path: `execution.imports[${JSON.stringify(key)}]`,
        message: "Array must be non-empty (omit the key instead of providing []).",
      });
      continue;
    }
    refs.forEach((raw, i) => {
      if (typeof raw !== "string") {
        errors.push({
          path: `execution.imports[${JSON.stringify(key)}][${i}]`,
          message: `Ref must be a string, got ${typeof raw}.`,
        });
        return;
      }
      if (classifyRuntimeImportRef(raw) === "invalid") {
        errors.push({
          path: `execution.imports[${JSON.stringify(key)}][${i}]`,
          message: `Ref ${JSON.stringify(raw)} is neither a Leo program id (bare or .aleo) nor a path (contains \`/\`, \`\\\\\`, or starts with \`~\`).`,
        });
      }
    });
  }
  return errors;
}

function validateExecutionResolvedConfig(
  resolved: LionDenResolvedConfig,
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];
  for (const [key, refs] of Object.entries(resolved.execution.imports)) {
    refs.forEach((ref, i) => {
      const diagnostic = checkRuntimeImportRefExists(
        ref,
        `execution.imports[${JSON.stringify(key)}][${i}]`,
      );
      if (diagnostic) {
        errors.push({ path: diagnostic.path, message: diagnostic.message });
      }
    });
  }
  return errors;
}

function mergeSdkConfig(
  base: LionDenResolvedConfig["sdk"],
  partial: Partial<LionDenResolvedConfig["sdk"]> | undefined,
): LionDenResolvedConfig["sdk"] {
  const mergedKeyCache = {
    ...base.keyCache,
    ...(partial?.keyCache ?? {}),
  };

  return {
    ...base,
    ...(partial ?? {}),
    keyCache: mergedKeyCache.storage === "memory"
      ? { storage: "memory" }
      : mergedKeyCache,
  };
}
