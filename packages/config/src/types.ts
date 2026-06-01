import type { ConfigVariable } from "./config-variable.js";

// Re-export for convenience
export type { ConfigVariable } from "./config-variable.js";

// ---------------------------------------------------------------------------
// Named accounts — user-facing config types
// ---------------------------------------------------------------------------

/**
 * A single value for a named account entry.
 * - number: devnode account index (e.g. 0 → DEVNODE_ACCOUNTS[0])
 * - string matching "aleo1...": a literal Aleo address (address-only)
 * - string matching "APrivateKey1...": a literal private key (signable)
 * - ConfigVariable: resolved eagerly to a string, then classified by prefix
 */
export type NamedAccountValue = number | string | ConfigVariable;

/**
 * Per-account named account config.
 * The `default` key applies when no network-specific override is found.
 */
export interface NamedAccountConfig {
  readonly default?: NamedAccountValue;
  readonly [networkName: string]: NamedAccountValue | undefined;
}

// ---------------------------------------------------------------------------
// Named accounts — resolved config types
// ---------------------------------------------------------------------------

/** A resolved named account value after config variable resolution. */
export type ResolvedNamedAccountValue =
  | { readonly type: "index"; readonly index: number }
  | { readonly type: "address"; readonly address: string }
  | { readonly type: "privateKey"; readonly privateKey: string };

/** A fully resolved named account entry with per-network overrides and default. */
export interface ResolvedNamedAccountEntry {
  readonly networks: Readonly<Record<string, ResolvedNamedAccountValue>>;
  readonly default?: ResolvedNamedAccountValue;
}

/** All resolved named accounts from config. */
export type ResolvedNamedAccountsConfig = Readonly<Record<string, ResolvedNamedAccountEntry>>;

// ---------------------------------------------------------------------------
// Network configurations
// ---------------------------------------------------------------------------

export interface DevnodeNetworkConfig {
  readonly type: "devnode";
  /** Socket address for the devnode REST API. Default: "127.0.0.1:3030" */
  readonly socketAddr?: string;
  /** Auto-create blocks on transaction broadcast. Default: true */
  readonly autoBlock?: boolean;
  /** Verbosity level (0-2). Default: 0 */
  readonly verbosity?: number;
  /** Accounts to use. Default: well-known devnode accounts */
  readonly accounts?: AccountConfig[];
  /** Genesis block path */
  readonly genesisPath?: string;
  /** Aleo network type. Default: "testnet" */
  readonly network?: AleoNetwork;
  /** Private key for the devnode validator. Default: well-known test key */
  readonly privateKey?: string;
  /**
   * Consensus heights for devnode startup (e.g., "0,1,2,3,4,5,6,7,8").
   * Required for V9/constructor support on devnode.
   * Leo backend only — rejected on the standalone backend.
   */
  readonly consensusHeights?: string;
  /**
   * Which devnode backend to drive.
   * - `"leo"`: the devnode bundled in the Leo CLI (`leo devnode start`).
   * - `"standalone"`: Provable's standalone `aleo-devnode` binary.
   * When omitted, the backend is auto-detected at start time: `aleo-devnode`
   * is preferred when present on PATH, otherwise the Leo CLI is used.
   */
  readonly provider?: "leo" | "standalone";
  /**
   * Path to the standalone `aleo-devnode` binary. The Leo binary comes from
   * the top-level `leoBinary`. Setting this is standalone-only: it forces the
   * standalone backend and fails clearly if the binary can't be run.
   */
  readonly binary?: string;
  /**
   * Directory for the standalone devnode's persistent ledger (`--storage`).
   * Standalone-only. Enables snapshot/restore. When unset, the devnode runs
   * in-memory and cannot snapshot.
   */
  readonly storagePath?: string;
  /**
   * Clear the storage directory before starting (`--clear-storage`).
   * Standalone-only and requires `storagePath`.
   */
  readonly clearStorageOnStart?: boolean;
  /**
   * Skip disk writes/reads for deployment state on this network.
   * When true, deployment records, ABI snapshots, history, and pending
   * markers are kept in memory only.
   * Default: true (devnode chain dies on process exit).
   */
  readonly ephemeral?: boolean;
}

export interface HttpNetworkConfig {
  readonly type: "http";
  /** Full endpoint URL, e.g. "https://api.explorer.provable.com/v1" */
  readonly endpoint: string;
  /** Network type */
  readonly network: AleoNetwork;
  /** Private key or ConfigVariable reference */
  readonly privateKey?: string | ConfigVariable;
  /** Optional API key for explorer */
  readonly apiKey?: string | ConfigVariable;
  /**
   * Skip disk writes/reads for deployment state on this network.
   * When true, deployment records, ABI snapshots, history, and pending
   * markers are kept in memory only.
   * Default: false (HTTP chains persist across restarts).
   */
  readonly ephemeral?: boolean;
}

export type NetworkUserConfig =
  | DevnodeNetworkConfig
  | HttpNetworkConfig;

export type AleoNetwork = "mainnet" | "testnet" | "canary";

export interface AccountConfig {
  /** Private key string or ConfigVariable reference */
  readonly privateKey: string | ConfigVariable;
  /** Optional label for this account */
  readonly name?: string;
}

/** Account config after variable resolution — privateKey is always a string. */
export interface ResolvedAccountConfig {
  readonly privateKey: string;
  readonly name?: string;
}

// ---------------------------------------------------------------------------
// Plugin and Task types (forward-declared here so config can reference them)
// ---------------------------------------------------------------------------

/**
 * Forward declaration for LionDenPlugin. The full interface is in @lionden/core.
 * This minimal shape is what the config needs to reference plugins.
 */
export interface LionDenPluginRef {
  readonly id: string;
}

/**
 * Forward declaration for TaskDefinition. The full interface is in @lionden/core.
 */
export interface TaskDefinitionRef {
  readonly id: string;
}

// ---------------------------------------------------------------------------
// User-facing config (what users write in lionden.config.ts)
// ---------------------------------------------------------------------------

export interface LionDenUserConfig {
  /**
   * Leo compatibility declaration. Default: "4.1.0".
   * Supported lines are currently 4.1.x, 4.0.x, and 3.5.x.
   */
  readonly leoVersion?: string;

  /**
   * Skip LionDen's Leo version compatibility comparison.
   *
   * This still requires the configured `leoBinary` to be executable and its
   * `--version` command to exit successfully. It only disables parsing and
   * comparing the reported version against `leoVersion`.
   */
  readonly skipLeoVersionCheck?: boolean;

  /**
   * Path to the Leo CLI binary.
   * When omitted, LionDen uses the `leo` binary found on `PATH`.
   * Useful for projects that target a specific Leo version (e.g., v3.5.0)
   * installed alongside the default.
   *
   * Tilde (`~/`) is expanded to the user's home directory during config resolution.
   *
   * @example "~/.leo/bin/leo-3.5"
   * @example "/Users/alice/.leo/bin/leo-3.5"
   */
  readonly leoBinary?: string;

  /** Path to Leo programs directory (relative to project root). Default: "programs" */
  readonly programsDir?: string;

  /** Path for build artifacts (relative to project root). Default: "artifacts" */
  readonly artifactsDir?: string;

  /** Path for generated TypeScript bindings (relative to project root). Default: "typechain" */
  readonly typechainDir?: string;

  /** Network configurations */
  readonly networks?: Record<string, NetworkUserConfig>;

  /** Default network to use. Default: "devnode" */
  readonly defaultNetwork?: string;

  /** Plugins to load. Core plugins loaded automatically. */
  readonly plugins?: LionDenPluginRef[];

  /** Additional tasks registered at the config level */
  readonly tasks?: TaskDefinitionRef[];

  /** Compilation settings */
  readonly compiler?: CompilerConfig;

  /** TypeScript codegen settings */
  readonly codegen?: CodegenConfig;

  /** Testing settings */
  readonly testing?: TestingConfig;

  /** Deploy settings */
  readonly deploy?: DeployConfig;

  /** Provable SDK integration settings */
  readonly sdk?: SdkConfig;

  /** Execution settings — runtime imports for dynamic dispatch, etc. */
  readonly execution?: ExecutionConfig;

  /**
   * Named accounts — human-readable roles mapped to per-network account values.
   *
   * @example
   * ```typescript
   * namedAccounts: {
   *   deployer: { default: 0, testnet: configVariable("DEPLOYER_KEY") },
   *   treasury: { default: "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5" },
   * }
   * ```
   */
  readonly namedAccounts?: Record<string, NamedAccountConfig>;
}

export interface CompilerConfig {
  /** Enable dead code elimination. Default: true */
  readonly enableDce?: boolean;
  /** Max conditional depth. Default: 10 */
  readonly conditionalBlockMaxDepth?: number;
  /** Build tests along with main. Default: false */
  readonly buildTests?: boolean;
  /** Additional leo build flags */
  readonly extraFlags?: readonly string[];
}

export interface CodegenConfig {
  /** Generate TypeScript bindings on compile. Default: true */
  readonly enabled?: boolean;
  /** Target directory for generated files (relative to project root) */
  readonly outDir?: string;
  /**
   * Generate Leo interface conversion helpers. Each entry emits a free
   * function in the program owning `sourceRecord`. Schema follows
   * `Leo.dynamicRecord(...)`'s `DynamicRecordSchema<T>` shape — each value is
   * a `${LeoPrimitiveType}.${LeoVisibility}` string. Map key becomes the
   * emitted function name.
   */
  readonly dynamicRecords?: Record<string, DynamicRecordHelperConfig>;
}

export interface DynamicRecordHelperConfig {
  /**
   * Generated TypeScript record type name (`pathToTsName(record.path)`).
   * Module-scoped records use their full disambiguated name, e.g.
   * `Foo_Bar_Token` for `foo::bar::Token`.
   */
  readonly sourceRecord: string;
  /**
   * Program ID (ending in `.aleo`) owning `sourceRecord`. Required only when
   * multiple compiled programs declare a record by the same generated name.
   */
  readonly sourceProgram?: string;
  /**
   * Per-field `<type>.<visibility>` schema. Keys must exactly match the
   * generated record shape (implicit `owner: address` + ABI fields +
   * implicit `_nonce: group`); visibility may differ per field.
   */
  readonly schema: Record<string, string>;
}

export interface TestingConfig {
  /** Test framework. Default: "vitest" */
  readonly framework?: "vitest";
  /** Timeout per test in ms. Default: 120000 */
  readonly timeout?: number;
  /** Auto-start devnode for tests. Default: true */
  readonly autoStartDevnode?: boolean;
}

export interface DeployConfig {
  /** Default priority fee in microcredits. Default: 0 */
  readonly defaultPriorityFee?: number;
  /** Pay fees from private records instead of public balance. Default: false */
  readonly privateFee?: boolean;
  /** Confirm transactions. Default: true */
  readonly confirmTransactions?: boolean;
  /** Confirmation timeout in ms. Default: 60000 */
  readonly confirmationTimeout?: number;
  /** Directory for deployment state (relative to project root). Default: "deployments" */
  readonly deploymentsDir?: string;
  /** Skip programs already deployed on-chain. Default: true */
  readonly skipDeployed?: boolean;
  /** Delay between dependent program deployments in ms (HTTP only). Default: 12000ms for HTTP, 0 for devnode */
  readonly interDeploymentDelay?: number;
  /** Automatically export deployment bundle after each deploy/upgrade. Default: false */
  readonly autoExport?: boolean;
  /**
   * Global override for deployment state ephemeral mode.
   * Overrides the per-network-type default (devnode=true, http=false)
   * but is itself overridden by per-network `ephemeral` settings.
   */
  readonly ephemeral?: boolean;
}

export interface SdkConfig {
  /**
   * SDK log level. Default: "warn".
   *
   * Applied only when the installed @provablehq/sdk exposes setLogLevel().
   */
  readonly logLevel?: SdkLogLevel;
  /** Proving/verifying key cache settings. Defaults to filesystem-backed caching. */
  readonly keyCache?: SdkKeyCacheConfig;
  /**
   * Overrides for the per-connection SDK network-host egress policy. By
   * default, `allowedNetworkHosts` is scoped to the configured endpoint
   * (devnode socket or http endpoint). Use `networkHosts` to extend with
   * sidecar / telemetry hosts and `violation` to switch between hard-block
   * and warn-only for rollout / debugging. Parameter-host (credits keys,
   * SRS) egress is governed by the SDK key cache and an internal known-host
   * list; see `network.md` § SDK Objects.
   */
  readonly egress?: SdkEgressConfig;
}

export const SDK_LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type SdkLogLevel = typeof SDK_LOG_LEVELS[number];

export interface SdkKeyCacheConfig {
  /** Cache storage backend. Default: "filesystem" */
  readonly storage?: "memory" | "filesystem";
  /** Filesystem cache directory. Relative paths resolve from project root. */
  readonly path?: string;
}

/**
 * Optional overrides for the SDK network-host egress policy. Host lists
 * are literal hostnames (no `https://` prefix, no shorthand strings). When
 * a field is omitted, the per-connection default applies (`networkHosts`:
 * the configured endpoint host only; `violation`: `"block"`).
 */
export interface SdkEgressConfig {
  /** Hosts the SDK may call for chain state / submission, in addition to the connection endpoint. */
  readonly networkHosts?: readonly string[];
  /** What to do on a disallowed network-host fetch. Default: "block". */
  readonly violation?: "block" | "warn";
}

export interface ExecutionConfig {
  /**
   * Runtime imports per dispatching program. Map keys are program ids
   * (bare names or `.aleo`-suffixed; normalized to canonical `.aleo` form).
   * Array entries are program ids OR paths to local `.aleo` files
   * (relative paths anchor to project root). Provides programs the VM
   * needs at execute time but cannot discover from the source's static
   * imports — e.g. dynamic-dispatch targets selected by a runtime
   * `identifier` value.
   *
   * @example
   * ```typescript
   * execution: {
   *   imports: {
   *     "governance.aleo": ["voting_power.aleo", "quadratic_power.aleo"],
   *   },
   * }
   * ```
   */
  readonly imports?: Record<string, readonly string[]>;
}

/**
 * Normalized runtime-import reference produced by config resolution and by
 * `AleoConnection` when API-level imports arrive. Either points at a known
 * program id (resolved later via artifacts → network) or at a local `.aleo`
 * file (already absolutized and existence-checked).
 */
export type RuntimeImportRef =
  | { readonly kind: "programId"; readonly programId: string }
  | { readonly kind: "path"; readonly absolutePath: string };

export interface ResolvedExecutionConfig {
  /** Map keys are canonical `.aleo` program ids; refs are normalized + deduped. */
  readonly imports: Readonly<Record<string, readonly RuntimeImportRef[]>>;
}

// ---------------------------------------------------------------------------
// Resolved config (all optionals filled, paths absolute, variables resolved)
// ---------------------------------------------------------------------------

export interface ResolvedPaths {
  /** Project root (where config file lives) */
  readonly root: string;
  /** Absolute path to programs directory */
  readonly programs: string;
  /** Absolute path to build artifacts */
  readonly artifacts: string;
  /** Absolute path to generated bindings */
  readonly typechain: string;
  /** Absolute path to cache directory */
  readonly cache: string;
  /** Absolute path to deployment state directory */
  readonly deployments: string;
}

export interface ResolvedCompilerConfig {
  readonly enableDce: boolean;
  readonly conditionalBlockMaxDepth: number;
  readonly buildTests: boolean;
  readonly extraFlags: readonly string[];
}

export interface ResolvedCodegenConfig {
  readonly enabled: boolean;
  readonly outDir: string;
  /**
   * Normalized dynamic-record helpers. Each entry carries the map-key
   * `helperName` field so codegen has everything it needs without re-keying.
   * `sourceProgram` stays optional in the resolved form; plugin-leo binds it
   * to the owning programId at codegen time when ABIs are available.
   */
  readonly dynamicRecords: Readonly<Record<string, ResolvedDynamicRecordHelper>>;
}

export interface ResolvedDynamicRecordHelper {
  readonly helperName: string;
  readonly sourceRecord: string;
  readonly sourceProgram?: string;
  readonly schema: Readonly<Record<string, string>>;
}

export interface ResolvedTestingConfig {
  readonly framework: "vitest";
  readonly timeout: number;
  readonly autoStartDevnode: boolean;
}

export interface ResolvedDeployConfig {
  readonly defaultPriorityFee: number;
  readonly privateFee: boolean;
  readonly confirmTransactions: boolean;
  readonly confirmationTimeout: number;
  readonly deploymentsDir: string;
  readonly skipDeployed: boolean;
  readonly interDeploymentDelay?: number;
  readonly autoExport: boolean;
}

export interface ResolvedSdkConfig {
  readonly logLevel?: SdkLogLevel;
  readonly keyCache: ResolvedSdkKeyCacheConfig;
  /**
   * User-supplied network-host egress overrides. `undefined` means
   * "use the per-connection default `allowedNetworkHosts = { endpoint host }`
   * with `violation = "block"`". The runtime `SdkEgressPolicy` is built
   * per-connection by `NetworkManager` from the connection endpoint plus
   * these overrides; it does not vary by network `type`.
   */
  readonly egress?: ResolvedSdkEgressConfig;
}

export interface ResolvedSdkKeyCacheConfig {
  readonly storage: "memory" | "filesystem";
  /** Absolute effective filesystem path when storage is "filesystem". */
  readonly path?: string;
}

export interface ResolvedSdkEgressConfig {
  readonly networkHosts?: readonly string[];
  readonly violation?: "block" | "warn";
}

/** Resolved network config — discriminated by type, all fields populated */
export interface ResolvedDevnodeNetworkConfig {
  readonly type: "devnode";
  readonly socketAddr: string;
  readonly autoBlock: boolean;
  readonly verbosity: number;
  readonly accounts: ResolvedAccountConfig[];
  readonly genesisPath?: string;
  readonly network: AleoNetwork;
  readonly privateKey?: string;
  readonly consensusHeights?: string;
  /** Devnode backend selection. Undefined ⇒ auto-detect at start time. */
  readonly provider?: "leo" | "standalone";
  /** Path to the standalone `aleo-devnode` binary (standalone backend only). */
  readonly binary?: string;
  /** Persistent ledger directory for the standalone backend (`--storage`). */
  readonly storagePath?: string;
  /** Clear `storagePath` before starting (`--clear-storage`). */
  readonly clearStorageOnStart?: boolean;
  /** Deployment state ephemeral mode. Default: true (devnode chain dies on exit). */
  readonly ephemeral: boolean;
}

export interface ResolvedHttpNetworkConfig {
  readonly type: "http";
  readonly endpoint: string;
  readonly network: AleoNetwork;
  readonly privateKey?: string;
  readonly apiKey?: string;
  /** Deployment state ephemeral mode. Default: false (HTTP chains persist). */
  readonly ephemeral: boolean;
}

export type ResolvedNetworkConfig =
  | ResolvedDevnodeNetworkConfig
  | ResolvedHttpNetworkConfig;

export interface LionDenResolvedConfig {
  readonly leoVersion: string;
  readonly skipLeoVersionCheck: boolean;
  /** Resolved path to the Leo CLI binary. Default: "leo" */
  readonly leoBinary: string;
  readonly paths: ResolvedPaths;
  readonly networks: Record<string, ResolvedNetworkConfig>;
  readonly defaultNetwork: string;
  readonly compiler: ResolvedCompilerConfig;
  readonly codegen: ResolvedCodegenConfig;
  readonly testing: ResolvedTestingConfig;
  readonly deploy: ResolvedDeployConfig;
  readonly sdk: ResolvedSdkConfig;
  readonly execution: ResolvedExecutionConfig;
  /** Resolved named accounts. Empty record when not configured. */
  readonly namedAccounts: ResolvedNamedAccountsConfig;
}
