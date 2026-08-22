/**
 * Locating the materialized Leo package, and guarding it against drift.
 *
 * `leo deploy --path <dir>` recompiles from that package's `src/` whenever
 * `src/` is newer than `build/` — measured, not assumed — and it overwrites
 * `build/` when it does. That is the hazard this module exists for: lionden
 * records the bytecode *it* compiled, from `artifacts/<id>/main.aleo`, and a
 * transaction built from anything else would be recorded under a hash it does
 * not match.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveBuildArtifacts } from "@lionden/leo-compiler";
import { LeoDeployError } from "./errors.js";

/** `<artifacts>/.build/<effectiveProgramId>` — the materialized package root. */
export function leoPackageDir(artifactsDir: string, effectiveProgramId: string): string {
  return path.join(artifactsDir, ".build", effectiveProgramId);
}

/** The `.aleo` lionden recorded at compile time. */
function recordedAleoPath(artifactsDir: string, effectiveProgramId: string): string {
  return path.join(artifactsDir, effectiveProgramId, "main.aleo");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Hash of the package's compiled `.aleo`, or null when it has not been built.
 *
 * Goes through the compiler's own `resolveBuildArtifacts` rather than
 * reimplementing the `build/<name>` layout probe — that layout is exactly the
 * thing that must not drift between the compiler and this backend.
 */
export function hashBuiltAleo(packageDir: string, effectiveProgramId: string): string | null {
  const artifacts = resolveBuildArtifacts(path.join(packageDir, "build"), effectiveProgramId);
  if (!artifacts.aleoPath || !fs.existsSync(artifacts.aleoPath)) return null;
  return sha256(fs.readFileSync(artifacts.aleoPath, "utf8"));
}

export interface LeoPackage {
  readonly dir: string;
  /** Hash of the built `.aleo` as it stood before Leo ran. */
  readonly aleoHashBefore: string;
}

/**
 * Locate the package and run the **pre-run** staleness check.
 *
 * This check produces a better error, earlier; it is not the one that protects
 * the invariant. It cannot be, because it runs before Leo has had the chance to
 * recompile. `assertPackageUnchanged` is the check that actually holds the line.
 */
export function resolveLeoPackage(artifactsDir: string, effectiveProgramId: string): LeoPackage {
  const dir = leoPackageDir(artifactsDir, effectiveProgramId);

  if (!fs.existsSync(dir)) {
    throw new LeoDeployError(
      `No compiled Leo package for "${effectiveProgramId}" at ${dir}. ` +
        `Run \`lionden compile\` first, or use \`--deploy-backend sdk\`.`,
      { programId: effectiveProgramId, stage: "package" },
    );
  }

  const built = hashBuiltAleo(dir, effectiveProgramId);
  if (built === null) {
    throw new LeoDeployError(
      `The Leo package for "${effectiveProgramId}" at ${dir} has no compiled program. ` +
        `Run \`lionden compile --force\`, or use \`--deploy-backend sdk\`.`,
      { programId: effectiveProgramId, stage: "package" },
    );
  }

  const recorded = recordedAleoPath(artifactsDir, effectiveProgramId);
  if (fs.existsSync(recorded)) {
    const recordedHash = sha256(fs.readFileSync(recorded, "utf8"));
    if (recordedHash !== built) {
      throw new LeoDeployError(
        `The Leo package for "${effectiveProgramId}" is out of step with the recorded artifact. ` +
          `${path.relative(artifactsDir, recorded)} hashes ${short(recordedHash)} but the package's ` +
          `compiled program hashes ${short(built)}. Deploying would record bytecode that was never ` +
          `built. Run \`lionden compile --force\`, or use \`--deploy-backend sdk\`.`,
        { programId: effectiveProgramId, stage: "package" },
      );
    }
  }

  return { dir, aleoHashBefore: built };
}

/**
 * **Post-run, pre-broadcast** check: did Leo rebuild the program under us?
 *
 * A change here means Leo compiled different bytecode than lionden is about to
 * record, so this aborts rather than warns — the transaction is discarded
 * unbroadcast. Confirmed reachable: with `src/` newer than `build/`, `leo
 * deploy` recompiled and the saved transaction carried a transition that the
 * recorded artifact did not have.
 */
export function assertPackageUnchanged(pkg: LeoPackage, effectiveProgramId: string): void {
  const after = hashBuiltAleo(pkg.dir, effectiveProgramId);
  if (after === pkg.aleoHashBefore) return;

  throw new LeoDeployError(
    `Leo rebuilt "${effectiveProgramId}" during the run: its compiled program hashed ` +
      `${short(pkg.aleoHashBefore)} before and ${short(after ?? "(missing)")} after. The ` +
      `transaction Leo built does not match the artifact lionden compiled, so it was NOT ` +
      `broadcast. This happens when \`src/\` is newer than \`build/\`. Run ` +
      `\`lionden compile --force\` and deploy again.`,
    { programId: effectiveProgramId, stage: "package" },
  );
}

function short(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash;
}
