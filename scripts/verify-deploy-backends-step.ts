/**
 * One backend arm of the deploy-backend parity run.
 *
 * Runs through `lionden run` rather than as a plain script so it gets a real
 * LRE and drives the real `deploy` task — the same task the CLI dispatches.
 * `scripts/verify-deploy-backends.mjs` owns the devnode lifecycle and the
 * comparison; this file owns only what has to happen inside one LRE.
 *
 * Parameters arrive through the environment because `lionden run` forwards no
 * arguments to the script.
 *
 * - `LIONDEN_VERIFY_BACKEND`   `"sdk" | "leo"` — the arm being run.
 * - `LIONDEN_VERIFY_PROGRAMS`  comma-separated program names to deploy in order.
 * - `LIONDEN_VERIFY_RENAME`    optional `<source>:<target>` deployed after them.
 * - `LIONDEN_VERIFY_OUT`       absolute path for this arm's JSON summary.
 */

import fs from "node:fs";
import path from "node:path";
import type { LionDenRuntimeEnvironment } from "@lionden/core";

interface DeployResultLike {
  readonly programId: string;
  readonly txId: string;
  readonly blockHeight?: number;
}

interface DryRunResultLike {
  readonly programId: string;
  readonly transaction: unknown;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the parity step script.`);
  return value;
}

/** Every file under the state directory, relative and sorted. */
function listStateFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort()) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

export default async function (lre: LionDenRuntimeEnvironment): Promise<void> {
  const backend = requireEnv("LIONDEN_VERIFY_BACKEND");
  const programs = requireEnv("LIONDEN_VERIFY_PROGRAMS").split(",");
  const outPath = requireEnv("LIONDEN_VERIFY_OUT");
  const rename = process.env["LIONDEN_VERIFY_RENAME"];

  const stateDir = lre.config.paths.deployments;
  const summary: Record<string, unknown> = { backend, stateDir };

  await lre.tasks.run("compile");

  // Dry-run first, and only while the state directory is still empty.
  //
  // `skipDeployed` (default true) plus the already-deployed preflight outcome
  // leaves nothing to deploy once the program is on-chain, so a dry-run after
  // the real deploy would return zero transactions and "non-empty" would pass
  // for the wrong reason. This is also the only place real-chain dry-run purity
  // is checked: the SDK's HTTP path cannot dry-run at all, and devnode state is
  // ephemeral in every other lane.
  if (backend === "leo") {
    const dryRun = (await lre.tasks.run("deploy", {
      program: programs[0],
      dryRun: true,
    })) as { mode: string; results: DryRunResultLike[] } | DryRunResultLike[];

    const dryRunResults = Array.isArray(dryRun) ? dryRun : dryRun.results;

    if (!dryRunResults?.length) {
      throw new Error(`Dry-run through the ${backend} backend produced no transactions.`);
    }
    for (const result of dryRunResults) {
      if (!result.transaction) {
        throw new Error(`Dry-run produced an empty transaction for ${result.programId}.`);
      }
    }

    const afterDryRun = listStateFiles(stateDir);
    if (afterDryRun.length > 0) {
      throw new Error(
        `Dry-run mutated deployment state at ${stateDir}: ${afterDryRun.join(", ")}. ` +
          `--dry-run must never write records or pending markers.`,
      );
    }

    summary["dryRun"] = {
      programIds: dryRunResults.map((r) => r.programId),
      stateFilesAfter: afterDryRun,
    };
  }

  const deployed: DeployResultLike[] = [];
  for (const program of programs) {
    const result = (await lre.tasks.run("deploy", { program })) as
      | { mode: string; results: DeployResultLike[] }
      | DeployResultLike[];
    deployed.push(...(Array.isArray(result) ? result : result.results));
  }

  if (rename) {
    const [source, target] = rename.split(":");
    const result = (await lre.tasks.run("deploy", { program: source, rename: target })) as
      | { mode: string; results: DeployResultLike[] }
      | DeployResultLike[];
    deployed.push(...(Array.isArray(result) ? result : result.results));
  }

  summary["deployed"] = deployed.map((r) => ({ programId: r.programId, txId: r.txId }));
  summary["stateFiles"] = listStateFiles(stateDir);

  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
}
