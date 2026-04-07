// ---------------------------------------------------------------------------
// Discovered compilation units
// ---------------------------------------------------------------------------

export interface DiscoveredProgram {
  readonly kind: "program";
  /** On-chain program ID, e.g. "hello.aleo" */
  readonly programId: string;
  /** Absolute path to the source directory containing main.leo */
  readonly sourceDir: string;
  /** Absolute path to main.leo */
  readonly entryFile: string;
  /** ALL .leo files under sourceDir (relative paths from sourceDir) */
  readonly allSources: string[];
}

export interface DiscoveredLibrary {
  readonly kind: "library";
  /** Library name (directory name), e.g. "math_utils" */
  readonly name: string;
  /** Absolute path to the source directory containing lib.leo */
  readonly sourceDir: string;
  /** Absolute path to lib.leo */
  readonly entryFile: string;
  /** ALL .leo files under sourceDir (relative paths from sourceDir) */
  readonly allSources: string[];
}

export type DiscoveredUnit = DiscoveredProgram | DiscoveredLibrary;

/** Get the unique identifier for a compilation unit */
export function unitId(unit: DiscoveredUnit): string {
  return unit.kind === "program" ? unit.programId : unit.name;
}

// ---------------------------------------------------------------------------
// Compilation results
// ---------------------------------------------------------------------------

export interface CompilationUnitResult {
  readonly unit: DiscoveredUnit;
  /** Whether compilation was skipped (cache hit) */
  readonly cached: boolean;
  /** Absolute path to the materialized package directory */
  readonly packageDir: string;
  /** Absolute path to build output directory */
  readonly buildDir: string;
}

export interface ProgramCompilationResult extends CompilationUnitResult {
  readonly unit: DiscoveredProgram;
  /** Parsed ABI (programs only) */
  readonly abi: import("./abi-types.js").ProgramABI;
  /** Absolute path to compiled .aleo file */
  readonly aleoSource: string;
}

export interface LibraryCompilationResult extends CompilationUnitResult {
  readonly unit: DiscoveredLibrary;
}

export type CompilationResult = ProgramCompilationResult | LibraryCompilationResult;

// ---------------------------------------------------------------------------
// Compiler options
// ---------------------------------------------------------------------------

export interface CompileOptions {
  /** Force recompile, ignoring cache */
  readonly force?: boolean;
  /** Skip TypeScript codegen */
  readonly noTypechain?: boolean;
  /** Compile only this specific program/library */
  readonly program?: string;
}
