import { describe, it, expect } from "vitest";
import {
  TEMPLATES,
  getTemplate,
  getTemplateIds,
  sharedFiles,
} from "./templates.js";

describe("templates", () => {
  it("has at least two templates", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(2);
  });

  it("each template has a unique id", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each template has files", () => {
    for (const template of TEMPLATES) {
      expect(template.files.length).toBeGreaterThan(0);
    }
  });

  it("each template includes lionden.config.ts", () => {
    for (const template of TEMPLATES) {
      const paths = template.files.map((f) => f.path);
      expect(paths).toContain("lionden.config.ts");
    }
  });

  it("each template includes a programs/ directory", () => {
    for (const template of TEMPLATES) {
      const hasProgramFile = template.files.some((f) =>
        f.path.startsWith("programs/"),
      );
      expect(hasProgramFile).toBe(true);
    }
  });

  it("each template Leo program includes an ARC-0006 constructor", () => {
    for (const template of TEMPLATES) {
      const programFiles = template.files.filter((f) => f.path.endsWith(".leo"));
      expect(programFiles.length).toBeGreaterThan(0);

      for (const programFile of programFiles) {
        expect(programFile.content).toContain("@noupgrade");
        expect(programFile.content).toContain("constructor() {}");
      }
    }
  });

  it("each template includes a test file", () => {
    for (const template of TEMPLATES) {
      const hasTest = template.files.some((f) => f.path.startsWith("test/"));
      expect(hasTest).toBe(true);
    }
  });

  it("each template includes a deploy script", () => {
    for (const template of TEMPLATES) {
      const paths = template.files.map((f) => f.path);
      expect(paths).toContain("scripts/deploy.ts");
    }
  });

  it("each template config registers built-in plugins", () => {
    for (const template of TEMPLATES) {
      const config = template.files.find((f) => f.path === "lionden.config.ts");
      expect(config).toBeDefined();
      expect(config!.content).toContain("@lionden/plugin-leo");
      expect(config!.content).toContain("@lionden/plugin-network");
      expect(config!.content).toContain("@lionden/plugin-deploy");
      expect(config!.content).toContain("@lionden/plugin-test");
      expect(config!.content).toContain("plugins:");
    }
  });

  it("token template includes a recipe file", () => {
    const t = getTemplate("token")!;
    const paths = t.files.map((f) => f.path);
    expect(paths).toContain("recipes/setup.ts");
  });

  describe("getTemplate", () => {
    it("returns template by id", () => {
      const t = getTemplate("hello-world");
      expect(t).toBeDefined();
      expect(t!.id).toBe("hello-world");
    });

    it("returns undefined for unknown id", () => {
      expect(getTemplate("nonexistent")).toBeUndefined();
    });
  });

  describe("getTemplateIds", () => {
    it("returns array of template ids", () => {
      const ids = getTemplateIds();
      expect(ids).toContain("hello-world");
      expect(ids).toContain("token");
    });
  });

  describe("sharedFiles", () => {
    it("includes package.json with project name", () => {
      const files = sharedFiles("my-project");
      const pkg = files.find((f) => f.path === "package.json");
      expect(pkg).toBeDefined();
      expect(pkg!.content).toContain('"my-project"');
    });

    it("includes tsconfig.json", () => {
      const files = sharedFiles("test");
      const tsconfig = files.find((f) => f.path === "tsconfig.json");
      expect(tsconfig).toBeDefined();
      expect(tsconfig!.content).toContain("ES2024");
      expect(tsconfig!.content).toContain("typechain/**/*.ts");
    });

    it("includes .gitignore", () => {
      const files = sharedFiles("test");
      const gitignore = files.find((f) => f.path === ".gitignore");
      expect(gitignore).toBeDefined();
      expect(gitignore!.content).toContain("node_modules/");
    });

    it("package.json has @lionden dependencies including plugins", () => {
      const files = sharedFiles("test");
      const pkg = files.find((f) => f.path === "package.json");
      expect(pkg!.content).toContain("@lionden/cli");
      expect(pkg!.content).toContain("@lionden/config");
      expect(pkg!.content).toContain("@lionden/core");
      expect(pkg!.content).toContain("@lionden/testing");
      expect(pkg!.content).toContain("@lionden/plugin-leo");
      expect(pkg!.content).toContain("@lionden/plugin-network");
      expect(pkg!.content).toContain("@lionden/plugin-deploy");
      expect(pkg!.content).toContain("@lionden/plugin-test");
      expect(pkg!.content).toContain("tsx");
    });
  });
});
