import { type LionDenResolvedConfig, parseBooleanEnv } from "@lionden/config";
import {
  ArgumentType,
  type ConfigHookHandlers,
  type ConfigValidationError,
  type LionDenPlugin,
  type TestingHookHandlers,
  task,
} from "@lionden/core";
import type { TestCoverageOptions } from "./test-runner.js";
import { runTests } from "./test-runner.js";

// Warn at most once per process when LIONDEN_PROVE holds an unrecognized value.
// Only the parent-process test action passes this callback to parseBooleanEnv —
// worker-side readers stay silent to avoid per-worker spam (Finding 3).
let warnedInvalidProveEnv = false;
function warnOnceInvalidProveEnv(value: string): void {
  if (warnedInvalidProveEnv) return;
  warnedInvalidProveEnv = true;
  console.warn(`Ignoring unrecognized LIONDEN_PROVE value "${value}" — treating as not set.`);
}

// ---------------------------------------------------------------------------
// Config hooks
// ---------------------------------------------------------------------------

const configHooks: ConfigHookHandlers = {
  validateResolvedConfig(config: LionDenResolvedConfig): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];

    if (config.testing.timeout <= 0) {
      errors.push({
        path: "testing.timeout",
        message: "Test timeout must be positive",
      });
    }

    const validFrameworks = ["vitest"];
    if (!validFrameworks.includes(config.testing.framework)) {
      errors.push({
        path: "testing.framework",
        message: `Unsupported test framework "${config.testing.framework}". Supported: ${validFrameworks.join(", ")}`,
      });
    }

    return errors;
  },
};

// ---------------------------------------------------------------------------
// Testing hooks
// ---------------------------------------------------------------------------

const testingHooks: TestingHookHandlers = {};

const coverageSourceRootEnv = "LIONDEN_TEST_COVERAGE_SOURCE_ROOT";
const coverageReportsDirectoryEnv = "LIONDEN_TEST_COVERAGE_REPORTS_DIRECTORY";
const coverageBlobOutputFileEnv = "LIONDEN_TEST_COVERAGE_BLOB_OUTPUT_FILE";

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const testTask = task("test", "Run tests with managed devnode lifecycle")
  .addOption({
    name: "grep",
    type: "string",
    description: "Filter tests by name pattern",
  })
  .addOption({
    name: "timeout",
    type: "number",
    description: "Test timeout in milliseconds",
  })
  .addFlag({
    name: "noCompile",
    description: "Skip compilation before running tests",
  })
  .addFlag({
    name: "parallel",
    description: "Run test files in parallel (default: serial, to avoid devnode contention)",
  })
  .addFlag({
    name: "coverage",
    description: "Collect package-source coverage for the test run",
  })
  .addPositionalArgument({
    name: "files",
    type: ArgumentType.FILE,
    description: "Test file or glob patterns to run",
    variadic: true,
  })
  .setAction(async (args, lre) => {
    const grep = args["grep"] as string | undefined;
    const timeout = args["timeout"] as number | undefined;
    const noCompile = args["noCompile"] as boolean | undefined;
    const parallel = args["parallel"] as boolean | undefined;
    const coverage = args["coverage"] as boolean | undefined;
    const positionals = args["_positional"] as string[] | undefined;
    const files = positionals && positionals.length > 0 ? positionals : undefined;

    // Resolve the effective prove preference. An explicit built-in --prove (or
    // --prove=false) wins; otherwise a truthy LIONDEN_PROVE forces proving
    // (consistent with deploy/upgrade). When the env — not a flag — is the
    // source, print one notice so the behavior is not silent.
    const globalProve = lre.globalOptions["prove"];
    const explicitProve = typeof globalProve === "boolean" ? globalProve : undefined;
    const envProve = parseBooleanEnv(process.env["LIONDEN_PROVE"], false, warnOnceInvalidProveEnv);
    const effectiveProve = explicitProve ?? envProve;

    if (effectiveProve && explicitProve === undefined) {
      console.log("Proving enabled via LIONDEN_PROVE");
    }

    // Resolve an explicit --network (seeded into globalOptions by the CLI boot
    // path). When present, bridge it to Vitest workers via LIONDEN_NETWORK so
    // each worker's LRE targets the same network; default runs leave it unset.
    const globalNetwork = lre.globalOptions["network"];
    const explicitNetwork = typeof globalNetwork === "string" ? globalNetwork : undefined;
    if (explicitNetwork) {
      console.log(`Running tests against network "${explicitNetwork}"`);
    }
    const globalConfigPath = lre.globalOptions["configPath"];
    const configPath = typeof globalConfigPath === "string" ? globalConfigPath : undefined;

    // Canonicalize/clear LIONDEN_PROVE BEFORE suiteSetup so testing hooks and
    // Vitest workers observe the same resolved value. Workers read the strict
    // `=== "true"` wrapper check, so canonicalize a truthy env to exactly
    // "true" here.
    if (effectiveProve) process.env["LIONDEN_PROVE"] = "true";
    else delete process.env["LIONDEN_PROVE"];

    // 1. Compile unless --no-compile
    if (!noCompile) {
      console.log("Compiling programs...");
      await lre.tasks.run("compile");
    }

    // 2. Dispatch suiteSetup hook
    await lre.hooks.serial("testing", "suiteSetup", { lre });

    try {
      // 3. Run tests via Vitest. Pass the resolved boolean so runTests simply
      // re-affirms the canonical env (idempotent) rather than re-deciding.
      const result = await runTests({
        root: lre.config.paths.root,
        configPath,
        grep,
        timeout: timeout ?? lre.config.testing.timeout,
        compile: !noCompile,
        prove: effectiveProve,
        network: explicitNetwork,
        parallel: parallel ?? false,
        coverage: resolveCoverageOptions(coverage ?? false),
        files,
      });

      console.log(
        `\nTests: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped` +
          ` (${result.testFiles} files)`,
      );

      if (!result.success) {
        throw new Error(`${result.failed} test(s) failed.`);
      }

      return result;
    } finally {
      // 4. Dispatch suiteTeardown hook
      await lre.hooks.serial("testing", "suiteTeardown", { lre });
    }
  })
  .build();

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const pluginTest: LionDenPlugin = {
  id: "@lionden/plugin-test",
  name: "Test Plugin",
  hookHandlers: {
    config: configHooks,
    testing: testingHooks,
  },
  tasks: [testTask],
};

export default pluginTest;

export { isProvableSdkConsoleNoise, silenceProvableSdkConsoleNoise } from "./sdk-console-filter.js";
export type { TestCoverageOptions, TestRunnerOptions, TestRunnerResult } from "./test-runner.js";
// Re-export test runner for programmatic use
export { runTests } from "./test-runner.js";

function resolveCoverageOptions(enabled: boolean): false | TestCoverageOptions {
  if (!enabled) return false;

  return {
    sourceRoot: process.env[coverageSourceRootEnv] ?? process.cwd(),
    reportsDirectory: process.env[coverageReportsDirectoryEnv],
    blobOutputFile: process.env[coverageBlobOutputFileEnv],
  };
}
