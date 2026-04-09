// Types
export type {
  DiscoveredUnit,
  DiscoveredProgram,
  DiscoveredLibrary,
  CompilationResult,
  ProgramCompilationResult,
  LibraryCompilationResult,
  CompileOptions,
  CompilationUnitResult,
} from "./types.js";

export { unitId } from "./types.js";

// ABI types
export type {
  ProgramABI,
  TransitionABI,
  StructABI,
  StructFieldABI,
  RecordABI,
  RecordFieldABI,
  MappingABI,
  StorageVariableABI,
  StorageType,
  AleoType,
  PlaintextType,
  PrimitiveType,
  StructRef,
  RecordRef,
  Mode,
  AbiInput,
  AbiOutput,
} from "./abi-types.js";

// Source discovery
export { discoverUnits, extractProgramId } from "./source-discovery.js";

// Import parser
export { parseImports } from "./import-parser.js";

// Dependency resolver
export {
  resolveDependencies,
  CircularDependencyError,
  type DependencyGraph,
} from "./dependency-resolver.js";

// Package materializer
export {
  materializePackage,
  linkLocalDependency,
  linkNetworkDependency,
  getCachedNetworkDep,
} from "./package-materializer.js";

// ABI parser
export { parseAbi, AbiParseError } from "./abi-parser.js";

// Cache
export { computeUnitHash, isCached, writeCache } from "./cache.js";

// Compiler pipeline
export {
  compilePipeline,
  CompilationError,
  defaultFetchNetworkDep,
  type CompilePipelineResult,
  type FetchNetworkDep,
} from "./compiler.js";

// Codegen
export { generateBindings, generateBaseContract } from "./codegen/typescript-generator.js";
export { primitiveToTs, plaintextToTs, aleoTypeToTs, pathToTsName } from "./codegen/type-mapper.js";
