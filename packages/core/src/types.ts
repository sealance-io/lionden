import type {
  ConfigVariable,
  LionDenResolvedConfig,
  LionDenUserConfig,
  NamedAccounts,
} from "@lionden/config";

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

export interface ConfigValidationError {
  /** Dotted path to the offending field, e.g. "networks.testnet.endpoint" */
  readonly path: string;
  /** Human-readable error description */
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Hook handler interfaces — one per category
// ---------------------------------------------------------------------------

export interface ConfigHookHandlers {
  /** Mutate user config during loading (inject defaults, add networks, etc.) */
  extendUserConfig?(config: LionDenUserConfig): Promise<LionDenUserConfig> | LionDenUserConfig;

  /** Validate user config — return errors for plugin-specific fields */
  validateUserConfig?(
    config: LionDenUserConfig,
  ): Promise<ConfigValidationError[]> | ConfigValidationError[];

  /** Transform UserConfig → partial ResolvedConfig for plugin-owned settings */
  resolveConfig?(
    userConfig: LionDenUserConfig,
    resolveConfigurationVariable: (v: ConfigVariable) => Promise<string>,
  ): Promise<Partial<LionDenResolvedConfig>> | Partial<LionDenResolvedConfig>;

  /** Final validation on the fully resolved config (cross-field checks) */
  validateResolvedConfig?(
    config: LionDenResolvedConfig,
  ): Promise<ConfigValidationError[]> | ConfigValidationError[];
}

export interface TestingHookHandlers {
  /** Before test suite begins (devnode lifecycle). */
  suiteSetup?(context: unknown): Promise<void> | void;

  /** After test suite completes. */
  suiteTeardown?(context: unknown): Promise<void> | void;

  /** Before each test (snapshot). */
  testSetup?(context: unknown): Promise<void> | void;

  /** After each test (revert). */
  testTeardown?(context: unknown): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Deployment hook context types
// ---------------------------------------------------------------------------

export interface ProgramDeployedContext {
  readonly programId: string;
  readonly txId: string;
  readonly blockHeight: number;
  readonly edition: number;
  readonly constructorType: string;
  readonly network: string;
}

export interface ProgramUpgradedContext extends ProgramDeployedContext {
  readonly previousEdition: number;
}

export interface DeploymentHookHandlers {
  /** Called after a program is successfully deployed on-chain. */
  programDeployed?(ctx: ProgramDeployedContext): Promise<void> | void;
  /** Called after a program is successfully upgraded on-chain. */
  programUpgraded?(ctx: ProgramUpgradedContext): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Hook categories map
// ---------------------------------------------------------------------------

export type HookCategory = "config" | "testing" | "deployment";

export type HookHandlerMap = {
  config: ConfigHookHandlers;
  testing: TestingHookHandlers;
  deployment: DeploymentHookHandlers;
};

type HookHandlersFor<C extends HookCategory> = HookHandlerMap[C];

export type HookHandlerProvider<C extends HookCategory> =
  | (() => Promise<HookHandlersFor<C>>)
  | HookHandlersFor<C>;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export enum ArgumentType {
  STRING = "STRING",
  INT = "INT",
  BOOLEAN = "BOOLEAN",
  BIGINT = "BIGINT",
  FILE = "FILE",
}

// ---------------------------------------------------------------------------
// Global options
// ---------------------------------------------------------------------------

export interface GlobalOptionDefinition {
  readonly name: string;
  readonly description: string;
  readonly type: ArgumentType;
  readonly defaultValue?: unknown;
}

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------

export interface TaskOption {
  readonly name: string;
  readonly description: string;
  readonly type: "string" | "number";
  readonly defaultValue?: unknown;
  readonly required?: boolean;
}

export interface TaskFlag {
  readonly name: string;
  readonly description: string;
}

export interface TaskPositionalArgument {
  readonly name: string;
  readonly type: ArgumentType;
  readonly description?: string;
  readonly required?: boolean;
}

export type TaskAction = (
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
) => Promise<unknown>;

export type TaskActionWithSuper = (
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
  runSuper: (args: Record<string, unknown>) => Promise<unknown>,
) => Promise<unknown>;

export interface TaskDefinition {
  readonly id: string;
  readonly description: string;
  readonly action: TaskAction;
  readonly options?: readonly TaskOption[];
  readonly flags?: readonly TaskFlag[];
  readonly positionalArguments?: readonly TaskPositionalArgument[];
  /** If set, this task overrides a task with this id */
  readonly overrides?: string;
}

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

export interface LionDenPlugin {
  /** Unique identifier, e.g. "@lionden/plugin-leo" */
  readonly id: string;

  /** Human-readable name for error messages and logs */
  readonly name?: string;

  /** Plugins that MUST be loaded before this one */
  readonly dependencies?: readonly LionDenPlugin[];

  /** Hook handlers by category — lazy-loaded via () => import() or eager objects */
  readonly hookHandlers?: Partial<{
    [C in HookCategory]: HookHandlerProvider<C>;
  }>;

  /** Tasks registered by this plugin */
  readonly tasks?: readonly TaskDefinition[];

  /** Global CLI options added by this plugin */
  readonly globalOptions?: readonly GlobalOptionDefinition[];

  /**
   * Called after LRE construction. Allows plugins to inject services
   * (e.g., network manager) into the runtime environment.
   */
  readonly extendLre?: (lre: LionDenRuntimeEnvironment) => void;
}

// ---------------------------------------------------------------------------
// LRE — LionDen Runtime Environment
// ---------------------------------------------------------------------------

export interface ArtifactStore {
  /** Get the ABI JSON for a compiled program */
  getAbi(programId: string): unknown | undefined;
  /** Get the compiled .aleo source for a program */
  getAleoSource(programId: string): string | undefined;
  /** Get all compiled program IDs */
  getProgramIds(): string[];
  /** Store the ABI JSON for a compiled program */
  setAbi(programId: string, abi: unknown): void;
  /** Store the compiled .aleo source for a program */
  setAleoSource(programId: string, source: string): void;
}

export interface LionDenRuntimeEnvironment {
  /** Resolved configuration */
  readonly config: LionDenResolvedConfig;
  /** Network manager — create connections, manage devnode lifecycle */
  readonly network: unknown; // NetworkManager, defined in @lionden/network
  /** Deployment manager — track and query deployment state */
  readonly deployments: unknown; // DeploymentManager, defined in @lionden/plugin-deploy
  /** Task runner — execute tasks programmatically */
  readonly tasks: TaskRunner;
  /** Hook dispatcher — invoke hooks programmatically */
  readonly hooks: HookDispatcher;
  /** Compilation artifacts (populated after compile task) */
  readonly artifacts: ArtifactStore;
  /** Loaded plugins */
  readonly plugins: readonly LionDenPlugin[];
  /** Global option values */
  readonly globalOptions: Record<string, unknown>;
  /**
   * Resolved named accounts for the currently active network.
   * Populated by @lionden/plugin-network after connect().
   * Empty object ({}) when no namedAccounts are configured or before connect().
   */
  readonly namedAccounts: NamedAccounts;
}

// ---------------------------------------------------------------------------
// Forward declarations for TaskRunner and HookDispatcher
// ---------------------------------------------------------------------------

export interface TaskRunner {
  /** Run a task by ID with the given arguments */
  run(taskId: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Check if a task is registered */
  has(taskId: string): boolean;
  /** Get all registered task IDs */
  getTaskIds(): string[];
  /** Get the registered task definition, if any */
  getTaskDefinition(taskId: string): TaskDefinition | undefined;
}

export type HookDispatchMode = "serial" | "waterfall" | "collect";

export interface HookDispatcher {
  /** Dispatch a hook in serial mode — handlers execute sequentially */
  serial<TContext>(category: HookCategory, hookName: string, context: TContext): Promise<void>;

  /** Dispatch a hook in waterfall mode — each handler transforms previous result */
  waterfall<TValue>(
    category: HookCategory,
    hookName: string,
    initialValue: TValue,
    ...extraArgs: unknown[]
  ): Promise<TValue>;

  /** Dispatch a hook in collect mode — gather each handler's return value in plugin order */
  collect<TResult>(
    category: HookCategory,
    hookName: string,
    context: unknown,
    ...extraArgs: unknown[]
  ): Promise<TResult[]>;
}

// ---------------------------------------------------------------------------
// Deployment targets
// ---------------------------------------------------------------------------

/**
 * A program to deploy: either a bare program name / `.aleo` id, or any object
 * carrying a `programId` (e.g. a generated contract wrapper). Shared so that
 * `DeploymentContext.deploy` and `TestContext.deploy` stay structurally
 * identical by construction.
 */
export type ProgramDeploymentTarget = string | { readonly programId: string };

/** Resolve a {@link ProgramDeploymentTarget} to its program name/id string. */
export function programNameFromTarget(program: ProgramDeploymentTarget): string {
  return typeof program === "string" ? program : program.programId;
}
