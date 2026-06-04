import * as fs from "node:fs";
import * as path from "node:path";
import type { LionDenResolvedConfig, LionDenUserConfig } from "@lionden/config";
import {
  type CompilationHookHandlers,
  type ConfigHookHandlers,
  type ConfigValidationError,
  type LionDenPlugin,
  preflightLeo,
  task,
} from "@lionden/core";
import {
  CodegenError,
  type CompileOptions,
  compilePipeline,
  type GenerateBindingsOptions,
  generateBaseContract,
  generateBindings,
  type ProgramCompilationResult,
  pathToTsName,
  resolveContractClassName as resolveGeneratedContractClassName,
} from "@lionden/leo-compiler";

const VALID_TS_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEMA_ENTRY =
  /^(?:address|boolean|field|group|scalar|u(?:8|16|32|64|128)|i(?:8|16|32|64|128))\.(?:public|private)$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

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

    const supportedVersion = /^(?:4\.(?:0|1)|3\.5)\.(?:0|[1-9]\d*)$/;
    const plainStableVersion = /^\d+\.\d+\.\d+$/;
    const versionCheckSkipped = config.skipLeoVersionCheck === true;
    const versionPattern = versionCheckSkipped ? plainStableVersion : supportedVersion;

    if (config.leoVersion && !versionPattern.test(config.leoVersion)) {
      const message = versionCheckSkipped
        ? `Invalid Leo version "${config.leoVersion}". Expected a stable major.minor.patch version.`
        : `Unsupported Leo version "${config.leoVersion}". Supported lines: 4.1.x, 4.0.x, 3.5.x`;
      errors.push({
        path: "leoVersion",
        message,
      });
    }

    validateDynamicRecordsConfig(config, errors);

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
      fs.writeFileSync(path.join(typechainDir, "BaseContract.ts"), generateBaseContract());

      // Generate per-program bindings
      const allAbis = programResults.map((result) => result.abi);
      const helpersByProgram = resolveDynamicRecordHelpers(lre, programResults);
      for (const result of programResults) {
        const className = programIdToClassName(result.unit.programId);
        const dynamicRecords = helpersByProgram.get(result.unit.programId);
        const bindings = generateBindings(
          result.abi,
          allAbis,
          dynamicRecords ? { dynamicRecords } : {},
        );
        fs.writeFileSync(path.join(typechainDir, `${className}.ts`), bindings);
      }

      fs.writeFileSync(
        path.join(typechainDir, "index.ts"),
        buildTypechainIndex(programResults, helpersByProgram),
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

function buildTypechainIndex(
  programResults: readonly ProgramCompilationResult[],
  helpersByProgram: ReadonlyMap<string, NonNullable<GenerateBindingsOptions["dynamicRecords"]>>,
): string {
  const modules = programResults.map((result) => ({
    fileName: programIdToClassName(result.unit.programId),
    exports: getProgramExports(result, helpersByProgram.get(result.unit.programId) ?? []),
  }));
  const counts = new Map<string, number>();
  for (const module of modules) {
    for (const name of [...module.exports.types, ...module.exports.values]) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const lines = ['export * from "./BaseContract.js";'];
  const suppressed = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
  if (suppressed.length > 0) {
    lines.push(
      `// Omitted duplicate exports: ${suppressed.join(", ")}. Import them from the specific program module instead.`,
    );
  }
  for (const module of modules) {
    const safeTypes = module.exports.types.filter((name) => counts.get(name) === 1);
    const safeValues = module.exports.values.filter((name) => counts.get(name) === 1);
    if (safeTypes.length > 0) {
      lines.push(`export type { ${safeTypes.join(", ")} } from "./${module.fileName}.js";`);
    }
    if (safeValues.length > 0) {
      lines.push(`export { ${safeValues.join(", ")} } from "./${module.fileName}.js";`);
    }
  }
  return lines.join("\n") + "\n";
}

function getProgramExports(
  result: ProgramCompilationResult,
  helpers: readonly NonNullable<GenerateBindingsOptions["dynamicRecords"]>[number][],
): { types: string[]; values: string[] } {
  const abi = result.abi;
  const types = new Set<string>();
  const values = new Set<string>();
  const className = resolveGeneratedContractClassName(result.abi);

  for (const struct of abi.structs ?? []) {
    const name = pathToTsName(struct.path);
    types.add(name);
    values.add(`serialize${name}`);
    values.add(`deserialize${name}`);
  }

  for (const record of abi.records ?? []) {
    const name = pathToTsName(record.path);
    types.add(name);
    values.add(`serialize${name}`);
    values.add(`deserialize${name}`);
    values.add(`decrypt${name}`);
  }

  if ((abi.storage_variables ?? []).length > 0) {
    types.add(`${className}Storage`);
  }

  for (const helper of helpers) {
    values.add(helper.helperName);
  }

  values.add(className);
  values.add(`create${className}`);

  return { types: [...types], values: [...values] };
}

/**
 * Validate `codegen.dynamicRecords` shape in user config. Pushes structured
 * errors into `errors` so `resolveConfig` aggregates them into the
 * `ConfigResolutionError` shown to the user.
 *
 * Only validates shape — ABI-driven validation (sourceRecord exists, schema
 * primitives match record fields) runs at codegen time in
 * `resolveDynamicRecordHelpers` because it needs compiled ABIs.
 */
function validateDynamicRecordsConfig(
  config: LionDenUserConfig,
  errors: ConfigValidationError[],
): void {
  const raw = config.codegen?.dynamicRecords;
  if (raw === undefined) return;
  if (!isPlainObject(raw)) {
    errors.push({
      path: "codegen.dynamicRecords",
      message:
        "codegen.dynamicRecords must be a plain object mapping helper names to helper configs.",
    });
    return;
  }
  for (const [helperName, helper] of Object.entries(raw)) {
    const base = `codegen.dynamicRecords.${helperName}`;
    if (!VALID_TS_IDENTIFIER.test(helperName)) {
      errors.push({
        path: base,
        message: `Helper name "${helperName}" is not a valid TypeScript identifier (must match /^[A-Za-z_][A-Za-z0-9_]*$/).`,
      });
      continue;
    }
    if (!isPlainObject(helper)) {
      errors.push({
        path: base,
        message: `${base} must be a plain object with sourceRecord/schema fields.`,
      });
      continue;
    }
    const sourceRecord = helper["sourceRecord"];
    if (typeof sourceRecord !== "string" || sourceRecord.length === 0) {
      errors.push({
        path: `${base}.sourceRecord`,
        message: "sourceRecord must be a non-empty string (the generated TS record type name).",
      });
    } else if (!VALID_TS_IDENTIFIER.test(sourceRecord)) {
      errors.push({
        path: `${base}.sourceRecord`,
        message: `sourceRecord "${sourceRecord}" is not a valid TypeScript identifier.`,
      });
    }
    const sourceProgram = helper["sourceProgram"];
    if (sourceProgram !== undefined) {
      if (
        typeof sourceProgram !== "string" ||
        sourceProgram.length === 0 ||
        !sourceProgram.endsWith(".aleo")
      ) {
        errors.push({
          path: `${base}.sourceProgram`,
          message: 'sourceProgram must be a non-empty string ending in ".aleo".',
        });
      }
    }
    const schema = helper["schema"];
    if (!isPlainObject(schema)) {
      errors.push({
        path: `${base}.schema`,
        message:
          "schema must be a plain object mapping field names to <type>.<visibility> strings.",
      });
      continue;
    }
    if (Object.keys(schema).length === 0) {
      errors.push({
        path: `${base}.schema`,
        message: "schema must declare at least one field.",
      });
    }
    for (const [fieldName, entry] of Object.entries(schema)) {
      if (typeof entry !== "string" || !SCHEMA_ENTRY.test(entry)) {
        errors.push({
          path: `${base}.schema.${fieldName}`,
          message: `Schema entry must be "<type>.<visibility>" where type ∈ {address, boolean, field, group, scalar, u8-u128, i8-i128} and visibility ∈ {public, private}. Got ${JSON.stringify(entry)}.`,
        });
      }
    }
  }
}

/**
 * Bind each helper from `lre.config.codegen.dynamicRecords` to a specific
 * owning programId by scanning compiled ABIs for the source record name.
 * Throws `CodegenError` on missing/ambiguous/mismatched ownership.
 *
 * Returns a per-program list of resolved helpers ready to pass into
 * `generateBindings`. Programs with no helpers map to an empty array.
 *
 * Exported for unit testing — production callers go through the compile task.
 */
export function resolveDynamicRecordHelpers(
  lre: { readonly config: LionDenResolvedConfig },
  programResults: readonly ProgramCompilationResult[],
): Map<string, NonNullable<GenerateBindingsOptions["dynamicRecords"]>[number][]> {
  const helpersByProgram = new Map<
    string,
    NonNullable<GenerateBindingsOptions["dynamicRecords"]>[number][]
  >();
  const dynamicRecords = lre.config.codegen.dynamicRecords;
  if (!dynamicRecords || Object.keys(dynamicRecords).length === 0) {
    return helpersByProgram;
  }

  const ownership = new Map<string, string[]>();
  for (const result of programResults) {
    for (const record of result.abi.records) {
      const name = pathToTsName(record.path);
      const owners = ownership.get(name) ?? [];
      if (!owners.includes(result.unit.programId)) owners.push(result.unit.programId);
      ownership.set(name, owners);
    }
  }

  for (const helper of Object.values(dynamicRecords)) {
    const candidates = ownership.get(helper.sourceRecord) ?? [];
    if (candidates.length === 0) {
      throw new CodegenError(
        `codegen.dynamicRecords.${helper.helperName}.sourceRecord '${helper.sourceRecord}' does not match any local record in compiled programs.`,
        { helperName: helper.helperName, sourceRecord: helper.sourceRecord },
      );
    }
    let sourceProgram: string;
    if (helper.sourceProgram !== undefined) {
      if (!candidates.includes(helper.sourceProgram)) {
        throw new CodegenError(
          `codegen.dynamicRecords.${helper.helperName}.sourceProgram '${helper.sourceProgram}' does not declare record '${helper.sourceRecord}'. Candidates: [${candidates.join(", ")}].`,
          { helperName: helper.helperName, requested: helper.sourceProgram, candidates },
        );
      }
      sourceProgram = helper.sourceProgram;
    } else if (candidates.length === 1) {
      sourceProgram = candidates[0]!;
    } else {
      throw new CodegenError(
        `codegen.dynamicRecords.${helper.helperName} is ambiguous: record '${helper.sourceRecord}' is declared by [${candidates.join(", ")}]. Set \`sourceProgram\` to disambiguate.`,
        { helperName: helper.helperName, sourceRecord: helper.sourceRecord, candidates },
      );
    }
    const list = helpersByProgram.get(sourceProgram) ?? [];
    list.push({
      helperName: helper.helperName,
      sourceRecord: helper.sourceRecord,
      sourceProgram,
      schema: helper.schema,
    });
    helpersByProgram.set(sourceProgram, list);
  }
  return helpersByProgram;
}
