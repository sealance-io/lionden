import type { ConfigVariable } from "./config-variable.js";

// Re-export for convenience
export type { ConfigVariable } from "./config-variable.js";

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
}

export interface DevnetNetworkConfig {
  readonly type: "devnet";
  /** Number of validators. Default: 4 */
  readonly numValidators?: number;
  /** Number of clients. Default: 2 */
  readonly numClients?: number;
  /** Network type. Default: "testnet" */
  readonly network?: AleoNetwork;
  /** snarkOS binary path */
  readonly snarkosPath?: string;
  /** Verbosity (0-4). Default: 1 */
  readonly verbosity?: number;
  /** Base REST port. Default: 3030 */
  readonly restPort?: number;
  /** Storage directory */
  readonly storageDir?: string;
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
}

export type NetworkUserConfig =
  | DevnodeNetworkConfig
  | DevnetNetworkConfig
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
  /** Leo version requirement. Default: "4.0.0" */
  readonly leoVersion?: string;

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
}

export interface ResolvedDevnetNetworkConfig {
  readonly type: "devnet";
  readonly numValidators: number;
  readonly numClients: number;
  readonly network: AleoNetwork;
  readonly snarkosPath: string;
  readonly verbosity: number;
  readonly restPort: number;
  readonly storageDir?: string;
}

export interface ResolvedHttpNetworkConfig {
  readonly type: "http";
  readonly endpoint: string;
  readonly network: AleoNetwork;
  readonly privateKey?: string;
  readonly apiKey?: string;
}

export type ResolvedNetworkConfig =
  | ResolvedDevnodeNetworkConfig
  | ResolvedDevnetNetworkConfig
  | ResolvedHttpNetworkConfig;

export interface LionDenResolvedConfig {
  readonly leoVersion: string;
  readonly paths: ResolvedPaths;
  readonly networks: Record<string, ResolvedNetworkConfig>;
  readonly defaultNetwork: string;
  readonly compiler: ResolvedCompilerConfig;
  readonly codegen: ResolvedCodegenConfig;
  readonly testing: ResolvedTestingConfig;
  readonly deploy: ResolvedDeployConfig;
}
