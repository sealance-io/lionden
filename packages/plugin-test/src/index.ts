import {
  type LionDenPlugin,
  type TestingHookHandlers,
  type ConfigHookHandlers,
  type ConfigValidationError,
  ArgumentType,
  task,
} from "@lionden/core";
import type { LionDenResolvedConfig } from "@lionden/config";
import { runTests } from "./test-runner.js";

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
    name: "prove",
    description: "Generate proofs during execution (slower)",
  })
  .addFlag({
    name: "parallel",
    description: "Run test files in parallel (default: serial, to avoid devnode contention)",
  })
  .addPositionalArgument({
    name: "files",
    type: ArgumentType.FILE,
    description: "Test file or glob patterns to run",
  })
  .setAction(async (args, lre) => {
    const grep = args["grep"] as string | undefined;
    const timeout = args["timeout"] as number | undefined;
    const noCompile = args["noCompile"] as boolean | undefined;
    const prove = args["prove"] as boolean | undefined;
    const parallel = args["parallel"] as boolean | undefined;
    const positionals = args["_positional"] as string[] | undefined;
    const files = positionals && positionals.length > 0 ? positionals : undefined;

    // 1. Compile unless --no-compile
    if (!noCompile) {
      console.log("Compiling programs...");
      await lre.tasks.run("compile");
    }

    // 2. Dispatch suiteSetup hook
    await lre.hooks.serial("testing", "suiteSetup", { lre });

    try {
      // 3. Run tests via Vitest
      const result = await runTests({
        root: lre.config.paths.root,
        grep,
        timeout: timeout ?? lre.config.testing.timeout,
        compile: !noCompile,
        prove: prove ?? false,
        parallel: parallel ?? false,
        files,
      });

      console.log(
        `\nTests: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped` +
          ` (${result.testFiles} files)`,
      );

      if (!result.success) {
        throw new Error(
          `${result.failed} test(s) failed.`,
        );
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

// Re-export test runner for programmatic use
export { runTests } from "./test-runner.js";
export type { TestRunnerOptions, TestRunnerResult } from "./test-runner.js";
