// Types
export type {
  LionDenPlugin,
  LionDenRuntimeEnvironment,
  TaskDefinition,
  TaskAction,
  TaskActionWithSuper,
  TaskOption,
  TaskFlag,
  TaskPositionalArgument,
  TaskRunner,
  HookDispatcher,
  HookDispatchMode,
  HookCategory,
  HookHandlerMap,
  ConfigHookHandlers,
  CompilationHookHandlers,
  NetworkHookHandlers,
  TestingHookHandlers,
  DeploymentHookHandlers,
  ProgramDeployedContext,
  ProgramUpgradedContext,
  CompilationContext,
  CompilationResult,
  ArtifactStore,
  GlobalOptionDefinition,
  ConfigValidationError,
} from "./types.js";

export { ArgumentType } from "./types.js";

// Plugin loader
export {
  resolvePluginOrder,
  collectGlobalOptions,
  PluginLoadError,
} from "./plugin-loader.js";

// Hook system
export { HookDispatcherImpl } from "./hook-system.js";

// Task builder
export { task, overrideTask, TaskBuilder, OverrideTaskBuilder } from "./task-builder.js";

// Task runner
export { TaskRunnerImpl, TaskNotFoundError } from "./task-runner.js";

// Config resolution
export { resolveConfig, ConfigResolutionError } from "./config-resolution.js";
export type { ResolveConfigResult } from "./config-resolution.js";

// Leo CLI preflight
export { preflightLeo } from "./leo-preflight.js";

// LRE
export { createLre } from "./lre.js";
export type { CreateLreOptions } from "./lre.js";

// Key artifact metadata
export {
  KEY_ARTIFACTS_FORMAT,
  RUNTIME_KEY_CACHE_FORMAT,
  KeyArtifactsMetadataError,
  keyArtifactsMetadataPath,
  readKeyArtifactsMetadata,
  writeKeyArtifactsMetadata,
  readRuntimeKeyCacheMetadata,
  writeRuntimeKeyCacheMetadata,
  fingerprintBytes,
  fingerprintFile,
  sha256Text,
  sha256Json,
  verifyKeyFileRef,
  resolveKeyFileRef,
  fingerprintsEqual,
} from "./key-artifacts.js";
export type {
  KeyFingerprint,
  KeyFileRef,
  KeyArtifactFunctionRef,
  KeyArtifactsMetadata,
  RuntimeKeyIdentity,
  RuntimeKeyCacheDiagnostics,
  RuntimeKeyCacheMetadata,
} from "./key-artifacts.js";
