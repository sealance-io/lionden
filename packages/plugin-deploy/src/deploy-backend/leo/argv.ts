/**
 * Pure argv construction for `leo deploy` / `leo upgrade`.
 *
 * Kept free of I/O so the whole flag surface is testable as golden arrays. The
 * one non-obvious responsibility here is the `--skip` collision check, which is
 * a correctness guard rather than a formatting concern — see below.
 */

import type { AleoNetwork, SdkLogLevel } from "@lionden/config";
import { DeployError } from "../../errors.js";

export type LeoOperation = "deploy" | "upgrade";

export interface LeoArgvOptions {
  readonly operation: LeoOperation;
  /** Effective (post-rename) program id. Names the package directory. */
  readonly programId: string;
  /** Materialized Leo package: `<artifacts>/.build/<effectiveProgramId>`. */
  readonly packageDir: string;
  /** Throwaway directory for `--save`. */
  readonly saveDir: string;
  /** Absolute path for `--json-output`. */
  readonly jsonOutputPath: string;
  readonly networkId: AleoNetwork;
  readonly endpoint: string;
  readonly connectionType: "devnode" | "http";
  readonly consensusHeights?: string;
  readonly priorityFee: number;
  readonly privateFee: boolean;
  /** Local dependency ids to suppress. Must already exclude the root. */
  readonly localDependencyIds: readonly string[];
  readonly prove: boolean;
  readonly logLevel?: SdkLogLevel;
}

/**
 * Reject a `--skip` value that would also suppress the target program.
 *
 * Leo matches skips by **substring**, not by exact id: its own help says it
 * "skips deployment of any program that contains one of the given substrings"
 * (and the same, with the verb changed, for `upgrade`). This was confirmed
 * empirically — `--skip spike_a.aleo` also dropped `zspike_a.aleo`. A collision
 * here is silent and severe: Leo exits 0 having built nothing, which without
 * this check surfaces only as the outcome parser's no-file error, far from the
 * cause.
 *
 * Exported for direct testing; `buildLeoArgv` always calls it.
 */
export function assertNoSkipCollision(
  operation: LeoOperation,
  programId: string,
  localDependencyIds: readonly string[],
): void {
  const colliding = localDependencyIds.filter((dep) => programId.includes(dep));
  if (colliding.length === 0) return;

  throw new DeployError(
    `Cannot ${operation} "${programId}" with the Leo backend: its dependency ` +
      `${colliding.map((d) => `"${d}"`).join(", ")} would also suppress the program itself. ` +
      `Leo's \`--skip\` matches substrings, not exact program ids, and ` +
      `"${programId}" contains "${colliding[0]}". Rename one of the programs so neither id is a ` +
      `substring of the other, or use \`--deploy-backend sdk\`.`,
  );
}

/**
 * Build the full argument vector, `leo` itself excluded.
 *
 * Flag choices worth stating, because each one is a decision rather than a
 * translation:
 *
 * - `--disable-update-check` leads, matching `runLeoBuild`, so a daily update
 *   probe can never interpose on a deploy.
 * - `--save` without `--broadcast`: Leo builds, lionden broadcasts. That keeps
 *   ordering, pending markers, records and confirmation polling where they
 *   already are, and sidesteps Leo's exit-0-on-rejection behaviour entirely,
 *   since without `--broadcast` Leo never learns the chain's verdict.
 * - `--skip-deploy-certificate` only on devnode without `--prove`. It
 *   substitutes placeholder certificates and verifying keys, which a real
 *   network rejects, so it reproduces exactly what the SDK's devnode fast path
 *   already does.
 * - **Never** `--no-cache`: it defeats Leo's `~/.aleo` key cache, which is the
 *   resumability this backend exists to provide.
 * - **Never** `--rename`: `materializePackage` has already rewritten the
 *   program declaration into `.build/<effective-id>/`, so passing it would
 *   rename a second time.
 * - **Never** `--broadcast`, `--private-key`, `--build-tests`, `--no-local`,
 *   `--offline`, or `-p`. The private key travels in the environment (see
 *   `buildLeoEnv`); the rest either cost time or mean the opposite of what is
 *   wanted here.
 */
export function buildLeoArgv(options: LeoArgvOptions): string[] {
  assertNoSkipCollision(options.operation, options.programId, options.localDependencyIds);

  const argv: string[] = [
    "--disable-update-check",
    options.operation,
    "--path",
    options.packageDir,
    "--save",
    options.saveDir,
    `--json-output=${options.jsonOutputPath}`,
    "--yes",
    "--network",
    options.networkId,
    "--endpoint",
    options.endpoint,
  ];

  const isDevnode = options.connectionType === "devnode";
  if (isDevnode) argv.push("--devnet");

  // Devnode-only: a custom consensus schedule is meaningless against a real
  // network, which has its own.
  if (isDevnode && options.consensusHeights !== undefined) {
    argv.push("--consensus-heights", options.consensusHeights);
  }

  // Pipe-delimited and consumed in order, one per transaction. `--skip` forces
  // exactly one transaction per invocation, so a single bare integer is right.
  if (options.priorityFee > 0) argv.push("--priority-fees", String(options.priorityFee));

  // `default` means "pick fee records for me", matching the SDK's boolean.
  if (options.privateFee) argv.push("-f", "default");

  for (const dep of options.localDependencyIds) argv.push("--skip", dep);

  if (isDevnode && !options.prove) argv.push("--skip-deploy-certificate");

  const verbosity = leoVerbosityFlag(options.logLevel);
  if (verbosity) argv.push(verbosity);

  return argv;
}

function leoVerbosityFlag(logLevel: SdkLogLevel | undefined): "-q" | "-d" | null {
  if (logLevel === "silent" || logLevel === "error") return "-q";
  if (logLevel === "debug") return "-d";
  return null;
}
