import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TempProject } from "./temp-project.js";
import { TempProjectBuilder } from "./temp-project.js";

describe("TempProjectBuilder", () => {
  let project: TempProject | undefined;

  afterEach(() => {
    project?.cleanup();
    project = undefined;
  });

  it("build() creates the expected directory structure", () => {
    project = new TempProjectBuilder().build();

    expect(fs.existsSync(project.root)).toBe(true);
    expect(fs.existsSync(project.programsDir)).toBe(true);
    expect(fs.existsSync(project.artifactsDir)).toBe(true);
    expect(fs.existsSync(project.configPath)).toBe(true);
    expect(project.configPath).toBe(path.join(project.root, "lionden.config.ts"));
  });

  it("writes default config when none specified", () => {
    project = new TempProjectBuilder().build();

    const content = fs.readFileSync(project.configPath, "utf-8");
    expect(content).toBe("export default {};");
  });

  it("withConfig writes exact config string", () => {
    const configStr = `export default { leoVersion: "4.0.0" };`;
    project = new TempProjectBuilder().withConfig(configStr).build();

    const content = fs.readFileSync(project.configPath, "utf-8");
    expect(content).toBe(configStr);
  });

  it("withConfigObject serializes config as JSON", () => {
    project = new TempProjectBuilder()
      .withConfigObject({ leoVersion: "4.0.0", defaultNetwork: "testnet" })
      .build();

    const content = fs.readFileSync(project.configPath, "utf-8");
    expect(content).toContain('"leoVersion": "4.0.0"');
    expect(content).toContain('"defaultNetwork": "testnet"');
    expect(content).toMatch(/^export default /);
  });

  it("addProgram creates programs/<name>/main.leo with generated source", () => {
    project = new TempProjectBuilder().addProgram("hello").build();

    const mainLeo = path.join(project.programsDir, "hello", "main.leo");
    expect(fs.existsSync(mainLeo)).toBe(true);

    const source = fs.readFileSync(mainLeo, "utf-8");
    expect(source).toContain("program hello.aleo");
    expect(source).toContain("transition main");
  });

  it("addProgram with explicit source writes it verbatim", () => {
    const customSource = "program custom.aleo {\n  transition foo() {}\n}\n";
    project = new TempProjectBuilder().addProgram("custom", customSource).build();

    const mainLeo = path.join(project.programsDir, "custom", "main.leo");
    const source = fs.readFileSync(mainLeo, "utf-8");
    expect(source).toBe(customSource);
  });

  it("addProgramWithImports writes import lines", () => {
    project = new TempProjectBuilder()
      .addProgramWithImports("app", ["dep.aleo", "lib.aleo"])
      .build();

    const mainLeo = path.join(project.programsDir, "app", "main.leo");
    const source = fs.readFileSync(mainLeo, "utf-8");
    expect(source).toContain("import dep.aleo;");
    expect(source).toContain("import lib.aleo;");
    expect(source).toContain("program app.aleo");
  });

  it("addProgramWithImports writes custom constructor annotation", () => {
    project = new TempProjectBuilder()
      .addProgramWithImports("app", [], "@noupgrade\n    constructor() {}")
      .build();

    const mainLeo = path.join(project.programsDir, "app", "main.leo");
    const source = fs.readFileSync(mainLeo, "utf-8");
    expect(source).toContain("@noupgrade");
    expect(source).toContain("constructor() {}");
  });

  it("addProgramWithImports with empty annotation produces no constructor", () => {
    project = new TempProjectBuilder().addProgramWithImports("bare", [], "").build();

    const mainLeo = path.join(project.programsDir, "bare", "main.leo");
    const source = fs.readFileSync(mainLeo, "utf-8");
    expect(source).not.toContain("constructor");
    expect(source).toContain("program bare.aleo");
  });

  it("supports multiple programs", () => {
    project = new TempProjectBuilder()
      .addProgram("alpha")
      .addProgram("beta")
      .addProgramWithImports("gamma", ["alpha.aleo"])
      .build();

    expect(fs.existsSync(path.join(project.programsDir, "alpha", "main.leo"))).toBe(true);
    expect(fs.existsSync(path.join(project.programsDir, "beta", "main.leo"))).toBe(true);
    expect(fs.existsSync(path.join(project.programsDir, "gamma", "main.leo"))).toBe(true);
  });

  it("cleanup removes the temp directory", () => {
    project = new TempProjectBuilder().addProgram("hello").build();
    const root = project.root;

    expect(fs.existsSync(root)).toBe(true);
    project.cleanup();
    expect(fs.existsSync(root)).toBe(false);

    // Prevent afterEach from double-cleaning
    project = undefined;
  });
});
