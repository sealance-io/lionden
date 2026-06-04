// Types

export { canonicalizeAbiForHash, computeAbiHash } from "./abi-hash.js";
// ABI parser
export { AbiParseError, parseAbi } from "./abi-parser.js";

// ABI types
export type {
  AbiInput,
  AbiJsonValue,
  AbiOutput,
  AleoType,
  ConstParameterABI,
  InterfaceRefABI,
  MappingABI,
  Mode,
  PlaintextType,
  PrimitiveType,
  ProgramABI,
  RecordABI,
  RecordFieldABI,
  RecordRef,
  StorageType,
  StorageVariableABI,
  StructABI,
  StructFieldABI,
  StructRef,
  TransitionABI,
  ViewABI,
} from "./abi-types.js";
// Cache
export { computeUnitHash, isCached, writeCache } from "./cache.js";
export { CodegenError } from "./codegen/codegen-error.js";
export { aleoTypeToTs, pathToTsName, plaintextToTs, primitiveToTs } from "./codegen/type-mapper.js";
// Codegen
export {
  type GenerateBindingsOptions,
  generateBaseContract,
  generateBindings,
  resolveContractClassName,
} from "./codegen/typescript-generator.js";
// Compiler pipeline
export {
  CompilationError,
  type CompilePipelineResult,
  compilePipeline,
  defaultFetchNetworkDep,
  type FetchNetworkDep,
} from "./compiler.js";
// Dependency resolver
export {
  CircularDependencyError,
  type DependencyGraph,
  resolveDependencies,
} from "./dependency-resolver.js";
// Import parser
export { parseImports } from "./import-parser.js";
// Package materializer
export {
  getCachedNetworkDep,
  linkLocalDependency,
  linkNetworkDependency,
  materializePackage,
} from "./package-materializer.js";
// Source discovery
export { discoverUnits, extractProgramId } from "./source-discovery.js";
export type {
  CompilationResult,
  CompilationUnitResult,
  CompileOptions,
  DiscoveredLibrary,
  DiscoveredProgram,
  DiscoveredUnit,
  LibraryCompilationResult,
  ProgramCompilationResult,
} from "./types.js";
export { unitId } from "./types.js";
