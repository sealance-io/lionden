import type {
  LionDenUserConfig,
  LionDenResolvedConfig,
  ConfigVariable,
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
  extendUserConfig?(
    config: LionDenUserConfig,
  ): Promise<LionDenUserConfig> | LionDenUserConfig;

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

export interface CompilationHookHandlers {
  /** Before any compilation begins. */
  preBuild?(context: CompilationContext): Promise<void> | void;

  /** The actual compilation step. */
  compile?(context: CompilationContext): Promise<CompilationResult>;

  /** After ABI is generated (programs only), before codegen. Allows ABI transformation. */
  postAbi?(
    abi: unknown,
    context: CompilationContext,
  ): Promise<unknown> | unknown;

  /** TypeScript codegen step (programs only). */
  generateBindings?(
    abi: unknown,
    context: CompilationContext,
  ): Promise<string>;

  /** After all compilation is complete. */
  postBuild?(
    result: CompilationResult,
    context: CompilationContext,
  ): Promise<void> | void;
}

export interface NetworkHookHandlers {
  /** Before network connection is established. */
  preConnect?(config: unknown): Promise<unknown>;

  /** After network connection is ready. */
  postConnect?(connection: unknown): Promise<void> | void;

  /** Before a transaction is submitted. */
  preTransaction?(tx: unknown): Promise<unknown>;

  /** After a transaction is confirmed. */
  postTransaction?(result: unknown): Promise<void> | void;
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

/** Stub types — will be fully defined in @lionden/leo-compiler */
export interface CompilationContext {
  readonly config: LionDenResolvedConfig;
  readonly programs: readonly string[];
}

export interface CompilationResult {
  readonly success: boolean;
  readonly programs: readonly string[];
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Hook categories map
// ---------------------------------------------------------------------------

export type HookCategory = "config" | "compilation" | "network" | "testing";

export type HookHandlerMap = {
  config: ConfigHookHandlers;
  compilation: CompilationHookHandlers;
  network: NetworkHookHandlers;
  testing: TestingHookHandlers;
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
  readonly type: "string" | "boolean" | "number";
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
  readonly action:
    | TaskAction
    | (() => Promise<{ default: TaskAction }>);
  readonly options?: readonly TaskOption[];
  readonly flags?: readonly TaskFlag[];
  readonly positionalArguments?: readonly TaskPositionalArgument[];
  /** If set, this task overrides a task with this id */
  readonly overrides?: string;
  /** Tasks that must run before this task */
  readonly dependencies?: readonly string[];
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

  /** Plugins loaded only if the user already includes them */
  readonly conditionalDependencies?: readonly LionDenPlugin[];

  /** Hook handlers by category — lazy-loaded via () => import() or eager objects */
  readonly hookHandlers?: Partial<{
    [C in HookCategory]: HookHandlerProvider<C>;
  }>;

  /** Tasks registered by this plugin */
  readonly tasks?: readonly TaskDefinition[];

  /** Global CLI options added by this plugin */
  readonly globalOptions?: readonly GlobalOptionDefinition[];
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
}

export interface LionDenRuntimeEnvironment {
  /** Resolved configuration */
  readonly config: LionDenResolvedConfig;
  /** Network manager — create connections, manage devnode lifecycle */
  readonly network: unknown; // NetworkManager, defined in @lionden/network
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
}

export type HookDispatchMode = "serial" | "waterfall" | "parallel";

export interface HookDispatcher {
  /** Dispatch a hook in serial mode — handlers execute sequentially */
  serial<TContext>(
    category: HookCategory,
    hookName: string,
    context: TContext,
  ): Promise<void>;

  /** Dispatch a hook in waterfall mode — each handler transforms previous result */
  waterfall<TValue>(
    category: HookCategory,
    hookName: string,
    initialValue: TValue,
    ...extraArgs: unknown[]
  ): Promise<TValue>;

  /** Dispatch a hook in parallel mode — all handlers execute concurrently */
  parallel<TContext>(
    category: HookCategory,
    hookName: string,
    context: TContext,
  ): Promise<void>;
}
