import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// TempProject result
// ---------------------------------------------------------------------------

export interface TempProject {
  /** Absolute path to the temp project root. */
  readonly root: string;
  /** Absolute path to the config file. */
  readonly configPath: string;
  /** Absolute path to the programs/ directory. */
  readonly programsDir: string;
  /** Absolute path to the artifacts/ directory. */
  readonly artifactsDir: string;
  /** Remove the temp directory tree. */
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface ProgramEntry {
  name: string;
  source?: string;
  imports?: string[];
  annotation?: string;
}

export class TempProjectBuilder {
  private configContent?: string;
  private programs: ProgramEntry[] = [];

  /**
   * Write a raw config string as `lionden.config.ts`.
   *
   * @example
   * builder.withConfig(`export default { leoVersion: "4.0.0" };`)
   */
  withConfig(content: string): this {
    this.configContent = content;
    return this;
  }

  /**
   * Write a config from a partial object, serialized as
   * `export default <JSON>;`.
   */
  withConfigObject(config: Record<string, unknown>): this {
    this.configContent = `export default ${JSON.stringify(config, null, 2)};`;
    return this;
  }

  /**
   * Add a Leo program with verbatim source.
   * Creates `programs/<name>/main.leo`.
   *
   * If `source` is omitted, a minimal program body is generated.
   */
  addProgram(name: string, source?: string): this {
    this.programs.push({ name, source });
    return this;
  }

  /**
   * Add a Leo program with cross-program imports and optional constructor annotation.
   * Generates a standard `main.leo` with import lines, annotation, and a stub transition.
   */
  addProgramWithImports(name: string, imports: string[], annotation?: string): this {
    this.programs.push({ name, imports, annotation });
    return this;
  }

  /**
   * Create the temp directory structure and return paths + cleanup.
   */
  build(): TempProject {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-test-"));
    const programsDir = path.join(root, "programs");
    const artifactsDir = path.join(root, "artifacts");
    fs.mkdirSync(programsDir, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });

    // Write config file
    const configPath = path.join(root, "lionden.config.ts");
    const content = this.configContent ?? `export default {};`;
    fs.writeFileSync(configPath, content);

    // Write programs
    for (const prog of this.programs) {
      const progDir = path.join(programsDir, prog.name);
      fs.mkdirSync(progDir, { recursive: true });

      const source = prog.source ?? generateProgramSource(prog);
      fs.writeFileSync(path.join(progDir, "main.leo"), source);
    }

    return {
      root,
      configPath,
      programsDir,
      artifactsDir,
      cleanup() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  }
}

/**
 * Generate a minimal Leo program source from a ProgramEntry.
 */
function generateProgramSource(prog: ProgramEntry): string {
  const importLines = (prog.imports ?? []).map((imp) => `import ${imp};`).join("\n");

  const constructorBlock =
    prog.annotation !== undefined ? prog.annotation : "@noupgrade\n    constructor() {}";

  const prefix = importLines ? `${importLines}\n` : "";

  return `${prefix}program ${prog.name}.aleo {
    ${constructorBlock}

    transition main(a: u32, b: u32) -> u32 {
        return a + b;
    }
}
`;
}
