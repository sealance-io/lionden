/**
 * Turning a finished `leo deploy` / `leo upgrade` run into a broadcastable
 * transaction, or into a good error.
 *
 * Deliberately pure — files are read by the runner and handed in — so every
 * branch is testable against the committed capture corpus without a devnode.
 */

import type { LeoOperation } from "./argv.js";
import { LeoDeployError, type LeoDeployStage } from "./errors.js";

/**
 * `leo deploy --save <dir>` names its output by **program id**, not by
 * transaction id, and uses the same `.deployment.json` suffix for upgrades.
 */
export function savedTransactionFileName(programId: string): string {
  return `${programId}.deployment.json`;
}

/** Per-deployment costs from `--json-output`. */
export interface LeoDeploymentStats {
  readonly programSizeBytes?: number;
  readonly storageCost?: number;
  readonly namespaceCost?: number;
  readonly synthesisCost?: number;
  readonly constructorCost?: number;
  readonly priorityFee?: number;
  readonly totalCost?: number;
}

export interface LeoRunArtifacts {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  /** Redacted stdout tail. */
  readonly stdout: string;
  /** Redacted stderr tail. */
  readonly stderr: string;
  /** Contents of the `--save` directory, file name -> raw text. */
  readonly savedFiles: ReadonlyMap<string, string>;
  /** Raw `--json-output` text, or null when the file was never written. */
  readonly jsonOutput: string | null;
}

export interface LeoOutcome {
  /**
   * The saved transaction's exact bytes.
   *
   * Passed to `broadcastTransaction` unmodified: the file is a bare snarkVM
   * transaction — no wrapper — and `submitTransaction` accepts a string. This
   * was verified end to end against a devnode.
   *
   * Parsed for validation before it is returned, but never re-serialized: the
   * transaction id commits to the exact bytes.
   */
  readonly transaction: string;
  readonly transactionId: string | undefined;
  readonly stats: LeoDeploymentStats | undefined;
}

/**
 * Known Leo 4.3.2 stdout phrases, used only to enrich failure messages.
 *
 * They are **not** load-bearing for success detection. Because lionden always
 * builds with `--save` and never `--broadcast`, Leo never learns the chain's
 * verdict, which is what defuses its exit-0-on-rejection behaviour. Success is
 * decided by the presence of the saved file, never by a marker or exit code.
 */
const FAILURE_MARKERS: readonly { readonly marker: string; readonly hint: string }[] = [
  { marker: "Transaction rejected.", hint: "The network rejected the transaction." },
  { marker: "Transaction aborted.", hint: "The network aborted the transaction." },
  {
    marker: "Could not find the transaction.",
    hint: "Leo could not locate the transaction on the network within its search window.",
  },
  {
    marker: "' is not a valid upgrade: ",
    hint: "The program's constructor rejected the upgrade.",
  },
  { marker: " Failed to upgrade program ", hint: "The upgrade did not complete." },
  { marker: " Deployment skipped.", hint: "Leo skipped the deployment." },
];

/**
 * Read a finished run.
 *
 * Order matters, and the second step is the one that carries the weight:
 *
 * 1. Non-zero exit -> fatal, classified from stdout markers.
 * 2. Exit 0 with no saved file -> **still fatal**. Leo exits 0 when `--skip`
 *    matches everything, and it exits 0 on an on-chain rejection too. Success
 *    is never inferred from the exit code.
 * 3. Exit 0 with a saved file -> require exactly one, named for the target.
 * 4. Parse that file and require it to be a deployment of the target. The name
 *    is Leo's label for the blob, not evidence about what is inside it.
 * 5. `--json-output` is read opportunistically; a miss is never fatal.
 */
export function readLeoOutcome(
  operation: LeoOperation,
  programId: string,
  artifacts: LeoRunArtifacts,
): LeoOutcome {
  // Explicitly typed so TypeScript's never-returning-call analysis narrows
  // after each `fail(...)`; an inferred arrow does not qualify.
  const fail: (message: string, stage: LeoDeployStage) => never = (message, stage) => {
    throw new LeoDeployError(message, {
      programId,
      stage,
      exitCode: artifacts.exitCode,
      stderrTail: artifacts.stderr || artifacts.stdout,
    });
  };

  if (artifacts.signal) {
    fail(
      `Leo ${operation} for "${programId}" was terminated by signal ${artifacts.signal}. ` +
        `Re-run to resume — Leo caches synthesized proving keys under \`~/.aleo\`, so a repeat ` +
        `run skips the work already done.`,
      "run",
    );
  }

  if (artifacts.exitCode !== 0) {
    fail(
      `Leo ${operation} for "${programId}" failed with exit code ${artifacts.exitCode}.` +
        classifySuffix(artifacts),
      "run",
    );
  }

  const expected = savedTransactionFileName(programId);
  const saved = artifacts.savedFiles.get(expected);
  const otherFiles = [...artifacts.savedFiles.keys()].filter((name) => name !== expected);

  if (saved === undefined) {
    fail(
      `Leo ${operation} for "${programId}" exited successfully but wrote no transaction ` +
        `(expected "${expected}").` +
        (otherFiles.length > 0
          ? ` It saved ${otherFiles.map((f) => `"${f}"`).join(", ")} instead.`
          : "") +
        classifySuffix(artifacts) +
        ` A zero exit code does not mean success here: Leo also exits 0 when \`--skip\` matches ` +
        `every program. Re-run \`lionden compile --force\`, or use \`--deploy-backend sdk\`.`,
      "outcome",
    );
  }

  // lionden writes one pending marker and one deployment record per program, so
  // a second transaction would be silently unrecorded and unbroadcast.
  if (otherFiles.length > 0) {
    fail(
      `Leo ${operation} for "${programId}" produced ${otherFiles.length + 1} transactions ` +
        `instead of one: also ${otherFiles.map((f) => `"${f}"`).join(", ")}. ` +
        `lionden deploys one program per call and records each individually. ` +
        `Use \`--deploy-backend sdk\` if this persists.`,
      "outcome",
    );
  }

  // The file name is Leo's, not a proof of contents. Everything downstream —
  // the broadcast, the recorded txId, the deployment record — trusts this blob,
  // so check that it really is a deployment of the program that was asked for.
  const verified = verifySavedTransaction(operation, programId, saved, fail);

  const parsed = parseJsonOutput(artifacts.jsonOutput, programId);
  return {
    // The verified bytes, untouched: broadcasting a re-serialized document would
    // change field order and whitespace, and the transaction id commits to them.
    transaction: saved,
    // The saved transaction is what gets broadcast, so its own id outranks the
    // `--json-output` copy. They agreed in every captured run.
    transactionId: verified.transactionId ?? parsed?.transactionId,
    stats: parsed?.stats,
  };
}

/**
 * Confirm the saved file is a deployment transaction for `programId`.
 *
 * `leo deploy --save <dir>` names its output after the program it was asked to
 * deploy, so a mismatch is not an expected Leo behaviour — but "expected" is not
 * the standard here. An empty file (a truncated write, a full disk), a stale
 * file left by an earlier run, or a transaction for a different program would
 * all pass a name check and then be broadcast and recorded as this program's
 * deployment. Parsing costs one `JSON.parse` per deploy and rules all three out.
 *
 * Only the fields lionden actually depends on are checked. The rest of the
 * transaction is snarkVM's business, and the network validates it anyway.
 */
function verifySavedTransaction(
  operation: LeoOperation,
  programId: string,
  saved: string,
  fail: (message: string, stage: LeoDeployStage) => never,
): { transactionId: string | undefined } {
  const prefix = `Leo ${operation} for "${programId}" saved`;
  const suffix =
    ` The file was not broadcast. Re-run \`lionden compile --force\` and try again, ` +
    `or use \`--deploy-backend sdk\`.`;

  if (saved.trim().length === 0) {
    fail(`${prefix} an empty transaction file.${suffix}`, "outcome");
  }

  let doc: unknown;
  try {
    doc = JSON.parse(saved);
  } catch (error) {
    fail(
      `${prefix} a file that is not valid JSON: ${error instanceof Error ? error.message : String(error)}.${suffix}`,
      "outcome",
    );
  }

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    fail(`${prefix} a transaction file that is not a JSON object.${suffix}`, "outcome");
  }
  const tx = doc as Record<string, unknown>;

  // Upgrades are deployment transactions too — they carry a higher
  // `deployment.edition` — so both operations expect the same type here.
  if (tx["type"] !== "deploy") {
    fail(
      `${prefix} a transaction of type ${JSON.stringify(tx["type"])}, not a deployment.${suffix}`,
      "outcome",
    );
  }

  const deployment = tx["deployment"];
  const program =
    typeof deployment === "object" && deployment !== null
      ? (deployment as Record<string, unknown>)["program"]
      : undefined;
  if (typeof program !== "string") {
    fail(`${prefix} a deployment transaction with no program payload.${suffix}`, "outcome");
  }

  const declared = declaredProgramId(program);
  if (declared === undefined) {
    fail(
      `${prefix} a deployment whose program payload has no \`program <id>;\` declaration.${suffix}`,
      "outcome",
    );
  }
  if (declared !== programId) {
    fail(
      `${prefix} a deployment of "${declared}", not "${programId}". Broadcasting it would record ` +
        `the wrong program against this deployment.${suffix}`,
      "outcome",
    );
  }

  return { transactionId: typeof tx["id"] === "string" ? tx["id"] : undefined };
}

/**
 * The program id an Aleo bytecode payload declares.
 *
 * In Aleo instructions the `program <id>;` declaration is the first statement
 * after any `import` lines, and `program` appears at the start of a line nowhere
 * else — so a line-anchored match is exact, not a heuristic.
 */
function declaredProgramId(program: string): string | undefined {
  return /^program\s+([^\s;]+)\s*;/m.exec(program)?.[1];
}

function classifySuffix(artifacts: LeoRunArtifacts): string {
  const haystack = `${artifacts.stdout}\n${artifacts.stderr}`;
  const hit = FAILURE_MARKERS.find((entry) => haystack.includes(entry.marker));
  return hit ? ` ${hit.hint}` : "";
}

/**
 * Best-effort read of `--json-output`.
 *
 * Every field is optional. The file is absent whenever Leo fails before
 * building — including the common case of an unreachable endpoint — and the
 * `stats` object has two shapes: four constraint fields
 * (`total_variables`, `total_constraints`, `max_variables`, `max_constraints`)
 * appear only when a deployment certificate was generated, i.e. when
 * `--skip-deploy-certificate` was not passed. Nothing here is required for a
 * successful broadcast, so a miss is never fatal.
 */
function parseJsonOutput(
  raw: string | null,
  programId: string,
): { transactionId: string | undefined; stats: LeoDeploymentStats | undefined } | undefined {
  if (raw === null) return undefined;

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const deployments = (doc as { deployments?: unknown })?.deployments;
  if (!Array.isArray(deployments)) return undefined;

  const entry = deployments.find(
    (d): d is Record<string, unknown> =>
      typeof d === "object" &&
      d !== null &&
      (d as { program_id?: unknown }).program_id === programId,
  );
  if (!entry) return undefined;

  const rawStats = entry["stats"];
  const stats =
    typeof rawStats === "object" && rawStats !== null
      ? readStats(rawStats as Record<string, unknown>)
      : undefined;

  return {
    transactionId:
      typeof entry["transaction_id"] === "string" ? entry["transaction_id"] : undefined,
    stats,
  };
}

function readStats(raw: Record<string, unknown>): LeoDeploymentStats {
  const num = (key: string): number | undefined =>
    typeof raw[key] === "number" ? (raw[key] as number) : undefined;

  return {
    programSizeBytes: num("program_size_bytes"),
    storageCost: num("storage_cost"),
    namespaceCost: num("namespace_cost"),
    synthesisCost: num("synthesis_cost"),
    constructorCost: num("constructor_cost"),
    priorityFee: num("priority_fee"),
    totalCost: num("total_cost"),
  };
}
