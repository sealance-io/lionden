/**
 * A stand-in for the Leo CLI.
 *
 * Lives here rather than in `@lionden/test-internals` because that package
 * cannot depend on `plugin-deploy` — the dependency runs the other way — and
 * `LeoRunner`/`LeoRunRequest` are defined here.
 *
 * It behaves like the real binary in the one respect the backend cares about:
 * it writes its outputs into the `--save` directory and `--json-output` path it
 * is given, parsed out of the argv it receives, so tests exercise the real
 * file-discovery and outcome-parsing path instead of stubbing over it.
 */

import fs from "node:fs";
import { redactSecrets } from "@lionden/core";
import { savedTransactionFileName } from "./outcome.js";
import type { LeoRunner, LeoRunRequest, LeoRunResult } from "./runner.js";

/**
 * A saved transaction shaped like the real thing, for a given program.
 *
 * `readLeoOutcome` parses what it is handed and checks that it is a deployment
 * of the program that was requested, so a fake run cannot use an opaque
 * placeholder string. Only the fields lionden reads are populated; the rest of
 * a real transaction is snarkVM's business.
 */
export function fakeDeploymentTransaction(
  programId: string,
  overrides: { readonly id?: string; readonly edition?: number } = {},
): string {
  return JSON.stringify({
    type: "deploy",
    id: overrides.id ?? `at1fake${programId.replace(/[^a-z0-9]/g, "")}`,
    owner: { address: "aleo1fakeowner", signature: "sign1fake" },
    deployment: {
      edition: overrides.edition ?? 0,
      program: `program ${programId};\n\nfunction main:\n    input r0 as u32.private;\n`,
    },
    fee: {},
  });
}

export interface FakeLeoCliOptions {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
  /** Program id -> transaction text, written into the `--save` directory. */
  readonly savedTransactions?: Readonly<Record<string, string>>;
  /** Extra files to drop in the `--save` directory, by exact name. */
  readonly extraSavedFiles?: Readonly<Record<string, string>>;
  /** Written to `--json-output`. Omit for "Leo never wrote one". */
  readonly jsonOutput?: string;
  /** Runs before the result is produced — use it to mutate the package. */
  readonly onRun?: (request: LeoRunRequest) => void;
}

export class FakeLeoCli {
  /** Every invocation, in order. Assert on `argv`, `env`, `cwd`, `secrets`. */
  readonly calls: LeoRunRequest[] = [];

  constructor(private readonly options: FakeLeoCliOptions = {}) {}

  /** The value to pass as `LeoDeployBackendOptions.runner`. */
  readonly runner: LeoRunner = async (request) => {
    this.calls.push(request);
    this.options.onRun?.(request);

    const saveDir = flagValue(request.argv, "--save");
    if (saveDir) {
      for (const [programId, text] of Object.entries(this.options.savedTransactions ?? {})) {
        fs.writeFileSync(`${saveDir}/${savedTransactionFileName(programId)}`, text);
      }
      for (const [name, text] of Object.entries(this.options.extraSavedFiles ?? {})) {
        fs.writeFileSync(`${saveDir}/${name}`, text);
      }
    }

    const jsonOutputPath = inlineFlagValue(request.argv, "--json-output");
    if (jsonOutputPath && this.options.jsonOutput !== undefined) {
      fs.writeFileSync(jsonOutputPath, this.options.jsonOutput);
    }

    return {
      exitCode: this.options.exitCode ?? 0,
      signal: this.options.signal ?? null,
      // Redacted the way `spawnLeoRunner` redacts, so the fake is never laxer
      // than the real thing. A fake that handed back raw output would let a
      // test "prove" an error message is clean when the real path leaks.
      stdout: redactSecrets(this.options.stdout ?? "", request.secrets),
      stderr: redactSecrets(this.options.stderr ?? "", request.secrets),
      timedOut: this.options.timedOut ?? false,
    } satisfies LeoRunResult;
  };

  /** The single call, asserting there was exactly one. */
  get onlyCall(): LeoRunRequest {
    if (this.calls.length !== 1) {
      throw new Error(`Expected exactly 1 Leo invocation, got ${this.calls.length}`);
    }
    return this.calls[0]!;
  }
}

/** `--flag value` */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `--flag=value` */
function inlineFlagValue(argv: readonly string[], flag: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${flag}=`));
  return hit?.slice(flag.length + 1);
}
