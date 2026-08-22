/**
 * The Leo backend's own, mandatory binary version gate.
 *
 * Gating on `config.leoVersion` alone is not enough, because both mechanisms
 * that normally tie that value to the actual binary fail open on this path:
 *
 * - `preflightLeo` returns before comparing versions when `skipLeoVersionCheck`
 *   is set. It still proves the binary runs, but nothing about which line.
 * - `preflightLeo` is only invoked from the compile task and from
 *   `preflightDevnode`, and `lionden deploy --noCompile` skips compilation
 *   entirely — so on that path no version check runs at all.
 *
 * Either route lets a 3.5 or 4.1 binary reach `leo deploy` with a 4.3-only
 * argv, which produces a confusing clap error at best and a wrong-flag
 * deployment at worst. Hence a check that is independent of both.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseLeoVersionOutput } from "@lionden/core";
import { LEO_DEPLOY_BACKEND_LINE, supportsLeoDeployBackend } from "../../leo-version.js";
import { LeoDeployError } from "./errors.js";

const execFileAsync = promisify(execFile);

/** Injectable for tests: returns the binary's `--version` output. */
export type LeoVersionProbe = (binary: string) => Promise<string>;

const defaultProbe: LeoVersionProbe = async (binary) => {
  const { stdout, stderr } = await execFileAsync(binary, ["--disable-update-check", "--version"], {
    timeout: 30_000,
  });
  return `${String(stdout)}\n${String(stderr)}`;
};

const memo = new Map<string, Promise<void>>();

/** Matches `clearLeoPreflightMemoForTests` / `devnode-backend.ts` conventions. */
export function clearLeoVersionGateMemoForTests(): void {
  memo.clear();
}

/**
 * Assert the binary at `leoBinary` is on the supported line.
 *
 * `skipLeoVersionCheck` deliberately does **not** relax this. That flag is an
 * escape hatch for patch-level drift on the compile path, not a license to run
 * the deploy backend against an unverified flag surface — so the message says
 * so and offers the SDK backend instead.
 *
 * Memoized per binary path so a multi-program deploy pays for it once.
 */
export function assertLeoBinaryVersion(
  leoBinary: string,
  probe: LeoVersionProbe = defaultProbe,
): Promise<void> {
  const existing = memo.get(leoBinary);
  if (existing) return existing;

  const promise = runGate(leoBinary, probe);
  memo.set(leoBinary, promise);
  // A failed probe must not be cached as a permanent verdict — the user may fix
  // their PATH and retry within the same process (notably in tests and in the
  // Vitest-managed test task).
  promise.catch(() => memo.delete(leoBinary));
  return promise;
}

async function runGate(leoBinary: string, probe: LeoVersionProbe): Promise<void> {
  let output: string;
  try {
    output = await probe(leoBinary);
  } catch (error) {
    throw new LeoDeployError(
      `Could not run \`${leoBinary} --version\` to verify the Leo CLI for the Leo deploy backend: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Install Leo ${LEO_DEPLOY_BACKEND_LINE}.x and ensure it is on PATH, or use ` +
        `\`--deploy-backend sdk\`.`,
      { stage: "version-gate" },
    );
  }

  const parsed = parseLeoVersionOutput(output);
  if (!parsed) {
    throw new LeoDeployError(
      `Could not parse a version from \`${leoBinary} --version\`. The Leo deploy backend requires ` +
        `Leo ${LEO_DEPLOY_BACKEND_LINE}.x. Use \`--deploy-backend sdk\` to proceed with the ` +
        `Provable SDK backend instead.`,
      { stage: "version-gate" },
    );
  }

  if (!supportsLeoDeployBackend(parsed.text)) {
    throw new LeoDeployError(
      `The Leo deploy backend supports Leo ${LEO_DEPLOY_BACKEND_LINE}.x only, but ` +
        `\`${leoBinary}\` reports ${parsed.text}. Other lines differ in their ` +
        `\`deploy\`/\`upgrade\` flag surface and have not been verified for this path. ` +
        `Note that \`skipLeoVersionCheck\` does not relax this check: it covers patch-level ` +
        `drift when compiling, not an unsupported line when deploying. ` +
        `Install Leo ${LEO_DEPLOY_BACKEND_LINE}.x, or use \`--deploy-backend sdk\`.`,
      { stage: "version-gate" },
    );
  }
}
