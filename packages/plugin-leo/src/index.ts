import * as fs from "node:fs";
import * as path from "node:path";
import {
  type LionDenPlugin,
  type ConfigHookHandlers,
  type CompilationHookHandlers,
  type ConfigValidationError,
  preflightLeo,
  task,
} from "@lionden/core";
import type { LionDenUserConfig, LionDenResolvedConfig } from "@lionden/config";
import {
  compilePipeline,
  generateBindings,
  generateBaseContract,
  type CompileOptions,
  type ProgramCompilationResult,
} from "@lionden/leo-compiler";

// ---------------------------------------------------------------------------
// Config hooks
// ---------------------------------------------------------------------------

const configHooks: ConfigHookHandlers = {
  validateUserConfig(config: LionDenUserConfig): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];

    if (
      config.skipLeoVersionCheck !== undefined &&
      typeof config.skipLeoVersionCheck !== "boolean"
    ) {
      errors.push({
        path: "skipLeoVersionCheck",
        message: "skipLeoVersionCheck must be a boolean",
      });
    }

    const supportedVersion = /^(?:4\.0|3\.5)\.(?:0|[1-9]\d*)$/;
    const plainStableVersion = /^\d+\.\d+\.\d+$/;
    const versionCheckSkipped = config.skipLeoVersionCheck === true;
    const versionPattern = versionCheckSkipped
      ? plainStableVersion
      : supportedVersion;

    if (config.leoVersion && !versionPattern.test(config.leoVersion)) {
      const message = versionCheckSkipped
        ? `Invalid Leo version "${config.leoVersion}". Expected a stable major.minor.patch version.`
        : `Unsupported Leo version "${config.leoVersion}". Supported lines: 4.0.x, 3.5.x`;
      errors.push({
        path: "leoVersion",
        message,
      });
    }

    return errors;
  },

  validateResolvedConfig(config: LionDenResolvedConfig): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];

    if (!fs.existsSync(config.paths.programs)) {
      errors.push({
        path: "paths.programs",
        message: `Programs directory does not exist: ${config.paths.programs}`,
      });
    }

    return errors;
  },
};

// ---------------------------------------------------------------------------
// Compilation hooks
// ---------------------------------------------------------------------------

const compilationHooks: CompilationHookHandlers = {};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const compileTask = task("compile", "Compile Leo programs and generate TypeScript bindings")
  .addOption({
    name: "force",
    type: "boolean",
    defaultValue: false,
    description: "Force recompile, ignoring cache",
  })
  .addFlag({ name: "noTypechain", description: "Skip TypeScript binding generation" })
  .addOption({
    name: "program",
    type: "string",
    description: "Compile only the specified program",
  })
  .setAction(async (args, lre) => {
    const options: CompileOptions = {
      force: args["force"] as boolean | undefined,
      noTypechain: args["noTypechain"] as boolean | undefined,
      program: args["program"] as string | undefined,
    };

    await preflightLeo(lre.config);

    const { results } = await compilePipeline(lre.config, options);

    // Populate lre.artifacts with compiled program ABIs and sources
    const programResults = results.filter(
      (r): r is ProgramCompilationResult => r.unit.kind === "program",
    );
    for (const result of programResults) {
      lre.artifacts.setAbi(result.unit.programId, result.abi);
      const aleoPath = typeof result.aleoSource === "string" ? result.aleoSource : "";
      if (aleoPath && fs.existsSync(aleoPath)) {
        lre.artifacts.setAleoSource(result.unit.programId, fs.readFileSync(aleoPath, "utf-8"));
      }
    }

    // Generate TypeScript bindings for programs
    if (!options.noTypechain && lre.config.codegen.enabled) {
      const typechainDir = lre.config.paths.typechain;
      fs.mkdirSync(typechainDir, { recursive: true });

      // Write BaseContract.ts
      fs.writeFileSync(
        path.join(typechainDir, "BaseContract.ts"),
        generateBaseContract(),
      );

      // Generate per-program bindings
      for (const result of programResults) {
        const className = programIdToClassName(result.unit.programId);
        const bindings = generateBindings(result.abi);
        fs.writeFileSync(
          path.join(typechainDir, `${className}.ts`),
          bindings,
        );
      }

      // Generate index.ts barrel export
      const exports = programResults.map((r) => {
        const className = programIdToClassName(r.unit.programId);
        return `export * from "./${className}.js";`;
      });
      exports.unshift('export { BaseContract } from "./BaseContract.js";');
      fs.writeFileSync(
        path.join(typechainDir, "index.ts"),
        exports.join("\n") + "\n",
      );
    }

    return results;
  })
  .build();

const cleanTask = task("clean", "Remove build artifacts and generated bindings")
  .setAction(async (_args, lre) => {
    const { artifacts, typechain } = lre.config.paths;

    if (fs.existsSync(artifacts)) {
      fs.rmSync(artifacts, { recursive: true });
    }

    if (fs.existsSync(typechain)) {
      fs.rmSync(typechain, { recursive: true });
    }
  })
  .build();

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const pluginLeo: LionDenPlugin = {
  id: "@lionden/plugin-leo",
  name: "Leo Compiler Plugin",
  hookHandlers: {
    config: configHooks,
    compilation: compilationHooks,
  },
  tasks: [compileTask, cleanTask],
};

export default pluginLeo;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function programIdToClassName(programId: string): string {
  const name = programId.replace(/\.aleo$/, "");
  return name
    .split(/[_\-.]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}
