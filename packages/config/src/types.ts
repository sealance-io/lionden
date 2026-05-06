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
   */
  readonly consensusHeights?: string;
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
   * Leo compatibility declaration. Default: "4.0.0".
   * Supported lines are currently 4.0.x and 3.5.x.
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
  /** Resolved named accounts. Empty record when not configured. */
  readonly namedAccounts: ResolvedNamedAccountsConfig;
}
