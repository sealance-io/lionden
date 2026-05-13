import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  normalizeProgramId,
  looksLikePath,
  classifyRuntimeImportRef,
  isValidExecutionImportsMapKey,
  normalizeRuntimeImportRef,
  checkRuntimeImportRefExists,
} from "./execution-imports.js";

describe("normalizeProgramId", () => {
  it("adds .aleo to bare names", () => {
    expect(normalizeProgramId("governance")).toBe("governance.aleo");
  });

  it("leaves canonical ids unchanged", () => {
    expect(normalizeProgramId("governance.aleo")).toBe("governance.aleo");
  });
});

describe("looksLikePath", () => {
  it("flags refs with forward slashes", () => {
    expect(looksLikePath("./voting_power.aleo")).toBe(true);
    expect(looksLikePath("artifacts/voting_power/main.aleo")).toBe(true);
  });

  it("flags refs with backslashes", () => {
    expect(looksLikePath("artifacts\\voting_power\\main.aleo")).toBe(true);
  });

  it("flags refs starting with ~", () => {
    expect(looksLikePath("~/programs/foo.aleo")).toBe(true);
  });

  it("does not flag bare names or .aleo ids", () => {
    expect(looksLikePath("governance")).toBe(false);
    expect(looksLikePath("governance.aleo")).toBe(false);
  });
});

describe("classifyRuntimeImportRef", () => {
  it("returns programId for bare names and .aleo ids", () => {
    expect(classifyRuntimeImportRef("governance")).toBe("programId");
    expect(classifyRuntimeImportRef("governance.aleo")).toBe("programId");
  });

  it("returns path for path-shaped refs", () => {
    expect(classifyRuntimeImportRef("./foo.aleo")).toBe("path");
    expect(classifyRuntimeImportRef("~/foo.aleo")).toBe("path");
  });

  it("returns invalid for empty or malformed refs", () => {
    expect(classifyRuntimeImportRef("")).toBe("invalid");
    expect(classifyRuntimeImportRef("foo.bar")).toBe("invalid");
    expect(classifyRuntimeImportRef("123abc")).toBe("invalid");
  });
});

describe("isValidExecutionImportsMapKey", () => {
  it("accepts bare names and .aleo ids", () => {
    expect(isValidExecutionImportsMapKey("governance")).toBe(true);
    expect(isValidExecutionImportsMapKey("governance.aleo")).toBe(true);
  });

  it("rejects paths and malformed keys", () => {
    expect(isValidExecutionImportsMapKey("./foo.aleo")).toBe(false);
    expect(isValidExecutionImportsMapKey("foo.bar")).toBe(false);
    expect(isValidExecutionImportsMapKey("")).toBe(false);
  });
});

describe("normalizeRuntimeImportRef", () => {
  const projectRoot = "/tmp/project-root-for-tests";

  it("canonicalizes bare names into programId refs", () => {
    expect(normalizeRuntimeImportRef("governance", projectRoot)).toEqual({
      kind: "programId",
      programId: "governance.aleo",
    });
  });

  it("keeps explicit .aleo ids as programId refs", () => {
    expect(normalizeRuntimeImportRef("governance.aleo", projectRoot)).toEqual({
      kind: "programId",
      programId: "governance.aleo",
    });
  });

  it("absolutizes relative path refs against projectRoot", () => {
    const ref = normalizeRuntimeImportRef("./artifacts/voting_power/main.aleo", projectRoot);
    expect(ref).toEqual({
      kind: "path",
      absolutePath: path.resolve(projectRoot, "./artifacts/voting_power/main.aleo"),
    });
  });

  it("expands ~ to the user's home dir", () => {
    const ref = normalizeRuntimeImportRef("~/foo.aleo", projectRoot);
    expect(ref).toEqual({ kind: "path", absolutePath: path.join(os.homedir(), "foo.aleo") });
  });

  it("preserves absolute path refs verbatim", () => {
    const ref = normalizeRuntimeImportRef("/etc/foo.aleo", projectRoot);
    expect(ref).toEqual({ kind: "path", absolutePath: "/etc/foo.aleo" });
  });

  it("throws on invalid refs", () => {
    expect(() => normalizeRuntimeImportRef("123abc", projectRoot)).toThrow(/Invalid runtime import ref/);
  });
});

describe("checkRuntimeImportRefExists", () => {
  it("returns null for programId refs (existence resolved later)", () => {
    const diag = checkRuntimeImportRefExists(
      { kind: "programId", programId: "voting_power.aleo" },
      "execution.imports[\"governance.aleo\"][0]",
    );
    expect(diag).toBeNull();
  });

  it("returns null when the path ref exists and is a file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-exec-imports-"));
    const filePath = path.join(dir, "voting_power.aleo");
    fs.writeFileSync(filePath, "program voting_power.aleo;\n");
    try {
      const diag = checkRuntimeImportRefExists(
        { kind: "path", absolutePath: filePath },
        "execution.imports[\"governance.aleo\"][0]",
      );
      expect(diag).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a diagnostic when the path ref is missing", () => {
    const missing = "/tmp/this/path/should/not/exist/foo.aleo";
    const diag = checkRuntimeImportRefExists(
      { kind: "path", absolutePath: missing },
      "execution.imports[\"governance.aleo\"][0]",
    );
    expect(diag).not.toBeNull();
    expect(diag!.path).toBe("execution.imports[\"governance.aleo\"][0]");
    expect(diag!.message).toContain(missing);
  });

  it("returns a diagnostic when the path is not a regular file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-exec-imports-"));
    try {
      const diag = checkRuntimeImportRefExists(
        { kind: "path", absolutePath: dir },
        "execution.imports[\"governance.aleo\"][0]",
      );
      expect(diag).not.toBeNull();
      expect(diag!.message).toContain("not a regular file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
