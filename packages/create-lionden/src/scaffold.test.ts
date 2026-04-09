import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffold } from "./scaffold.js";
import { getTemplate } from "./templates.js";

function tmpProject(): string {
  return join(tmpdir(), `create-lionden-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe("scaffold", () => {
  it("creates project directory with all files", async () => {
    const dir = tmpProject();
    dirs.push(dir);

    const template = getTemplate("hello-world")!;
    const result = await scaffold({
      projectDir: dir,
      projectName: "test-hello",
      template,
    });

    expect(result.projectDir).toBe(dir);
    expect(result.filesCreated).toBeGreaterThan(0);

    // Shared files
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);

    // Template files
    expect(existsSync(join(dir, "lionden.config.ts"))).toBe(true);
    expect(existsSync(join(dir, "programs/hello/main.leo"))).toBe(true);
    expect(existsSync(join(dir, "test/hello.test.ts"))).toBe(true);
    expect(existsSync(join(dir, "scripts/deploy.ts"))).toBe(true);
  });

  it("writes correct project name in package.json", async () => {
    const dir = tmpProject();
    dirs.push(dir);

    const template = getTemplate("hello-world")!;
    await scaffold({ projectDir: dir, projectName: "my-cool-project", template });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
    expect(pkg["name"]).toBe("my-cool-project");
  });

  it("scaffolds token template", async () => {
    const dir = tmpProject();
    dirs.push(dir);

    const template = getTemplate("token")!;
    const result = await scaffold({
      projectDir: dir,
      projectName: "my-token",
      template,
    });

    expect(result.filesCreated).toBeGreaterThan(0);
    expect(existsSync(join(dir, "programs/token/main.leo"))).toBe(true);
    expect(existsSync(join(dir, "test/token.test.ts"))).toBe(true);

    // Token program should have mapping
    const leo = readFileSync(join(dir, "programs/token/main.leo"), "utf-8");
    expect(leo).toContain("mapping balances");
    expect(leo).toContain("record Token");
  });

  it("creates nested directories for template files", async () => {
    const dir = tmpProject();
    dirs.push(dir);

    const template = getTemplate("hello-world")!;
    await scaffold({ projectDir: dir, projectName: "nested", template });

    // programs/hello/ should have been created
    expect(existsSync(join(dir, "programs", "hello", "main.leo"))).toBe(true);
  });

  it("scaffolds Leo programs with ARC-0006 constructors", async () => {
    const dir = tmpProject();
    dirs.push(dir);

    const template = getTemplate("hello-world")!;
    await scaffold({ projectDir: dir, projectName: "constructors", template });

    const leo = readFileSync(join(dir, "programs/hello/main.leo"), "utf-8");
    expect(leo).toContain("@noupgrade");
    expect(leo).toContain("constructor() {}");
  });

  it("throws on non-empty directory", async () => {
    const dir = tmpProject();
    dirs.push(dir);

    // Scaffold once
    const template = getTemplate("hello-world")!;
    await scaffold({ projectDir: dir, projectName: "first", template });

    // Second scaffold into same dir should fail
    await expect(
      scaffold({ projectDir: dir, projectName: "second", template }),
    ).rejects.toThrow("already exists and is not empty");
  });

  it("succeeds on existing empty directory", async () => {
    const dir = tmpProject();
    dirs.push(dir);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });

    const template = getTemplate("hello-world")!;
    const result = await scaffold({ projectDir: dir, projectName: "empty", template });
    expect(result.filesCreated).toBeGreaterThan(0);
  });

  it("config file imports defineConfig", async () => {
    const dir = tmpProject();
    dirs.push(dir);

    const template = getTemplate("hello-world")!;
    await scaffold({ projectDir: dir, projectName: "check", template });

    const config = readFileSync(join(dir, "lionden.config.ts"), "utf-8");
    expect(config).toContain("defineConfig");
    expect(config).toContain("@lionden/config");
  });

  it("test file imports @lionden/testing", async () => {
    const dir = tmpProject();
    dirs.push(dir);

    const template = getTemplate("token")!;
    await scaffold({ projectDir: dir, projectName: "check", template });

    const test = readFileSync(join(dir, "test/token.test.ts"), "utf-8");
    expect(test).toContain("@lionden/testing");
    expect(test).toContain("setup");
  });
});
