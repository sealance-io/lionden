import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RuntimeImportRef } from "./types.js";

/**
 * Primitive diagnostic shape produced by this module. Core wraps these into
 * its own `ConfigValidationError`; this package is zero-dep on `@lionden/core`
 * so it cannot reference that type directly.
 */
export interface RuntimeImportDiagnostic {
  /** Dotted path into the config tree, e.g. `execution.imports["foo.aleo"][1]`. */
  readonly path: string;
  readonly message: string;
}

const PROGRAM_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*\.aleo$/;
const BARE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAP_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(\.aleo)?$/;

/**
 * Normalize a bare program name or `.aleo` id into canonical `.aleo` form.
 * Returns the input unchanged when it's already canonical. Does not validate
 * — callers should classify first.
 */
export function normalizeProgramId(raw: string): string {
  return raw.endsWith(".aleo") ? raw : `${raw}.aleo`;
}

/**
 * Heuristic: does this ref string look like a filesystem path? A path
 * commitment is signalled by a separator or a `~` prefix. Mere `.aleo`
 * suffix does NOT count — `voting_power.aleo` is an id, not a path.
 */
export function looksLikePath(raw: string): boolean {
  return raw.includes("/") || raw.includes("\\") || raw.startsWith("~");
}

/**
 * Classify a runtime-import ref by shape alone. No filesystem checks.
 * Returns "invalid" for refs that match neither the program-id nor the
 * path shape (e.g. `foo.bar`, `123`, empty).
 */
export function classifyRuntimeImportRef(raw: string): "programId" | "path" | "invalid" {
  if (raw.length === 0) return "invalid";
  if (looksLikePath(raw)) return "path";
  if (PROGRAM_ID_PATTERN.test(raw) || BARE_NAME_PATTERN.test(raw)) {
    return "programId";
  }
  return "invalid";
}

/**
 * Validate a map key in `execution.imports`. Map keys are program ids only
 * (bare or `.aleo`); paths are rejected.
 */
export function isValidExecutionImportsMapKey(raw: string): boolean {
  return MAP_KEY_PATTERN.test(raw);
}

/**
 * Normalize a raw ref string into a `RuntimeImportRef`. Path refs are
 * anchored to `projectRoot` when relative, `~` is expanded, and the
 * result is the absolute path. No existence check — call
 * `checkRuntimeImportRefExists` for that.
 *
 * Throws if the ref does not classify (callers should have filtered with
 * `classifyRuntimeImportRef` first, but this gives a final safety net).
 */
export function normalizeRuntimeImportRef(raw: string, projectRoot: string): RuntimeImportRef {
  const kind = classifyRuntimeImportRef(raw);
  if (kind === "invalid") {
    throw new Error(
      `Invalid runtime import ref: ${JSON.stringify(raw)} — must be a Leo program id or a path to a .aleo file`,
    );
  }
  if (kind === "programId") {
    return { kind: "programId", programId: normalizeProgramId(raw) };
  }
  return { kind: "path", absolutePath: resolveAbsolutePath(raw, projectRoot) };
}

/**
 * Check that a path-shaped ref points at an existing file. Program-id refs
 * always return null (existence is resolved later via artifacts/network).
 * Returns a diagnostic when the file is missing or not a regular file.
 */
export function checkRuntimeImportRefExists(
  ref: RuntimeImportRef,
  configPath: string,
): RuntimeImportDiagnostic | null {
  if (ref.kind !== "path") return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(ref.absolutePath);
  } catch {
    return {
      path: configPath,
      message: `runtime import path not found: ${ref.absolutePath}`,
    };
  }
  if (!stat.isFile()) {
    return {
      path: configPath,
      message: `runtime import path is not a regular file: ${ref.absolutePath}`,
    };
  }
  return null;
}

function resolveAbsolutePath(raw: string, projectRoot: string): string {
  const expanded = expandHome(raw);
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
