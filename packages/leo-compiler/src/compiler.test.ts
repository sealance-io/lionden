import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LionDenResolvedConfig } from "@lionden/config";
import { keyArtifactsMetadataPath, readKeyArtifactsMetadata } from "@lionden/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeUnitHash } from "./cache.js";
import { CompilationError, compilePipeline, defaultFetchNetworkDep } from "./compiler.js";
import { UnitNameCollisionError } from "./index.js";
import { getCachedNetworkDep, linkNetworkDependency } from "./package-materializer.js";
import {
  MissingProgramDeclarationError,
  ProgramFolderNameMismatchError,
} from "./source-discovery.js";

/** Compute the same cache scope key the pipeline uses. */
function cacheScope(network: string, endpoint: string): string {
  const hash = crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 8);
  return `${network}-${hash}`;
}

// ---------------------------------------------------------------------------
// defaultFetchNetworkDep
// ---------------------------------------------------------------------------

describe("defaultFetchNetworkDep", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns program source on first successful path", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve("program credits.aleo;\n"),
    });

    const result = await defaultFetchNetworkDep("credits.aleo", "http://localhost:3030");
    expect(result).toBe("program credits.aleo;\n");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3030/testnet/program/credits.aleo",
    );
  });

  it("falls back to second path when first returns non-ok", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("program credits.aleo;\n"),
      });

    const result = await defaultFetchNetworkDep("credits.aleo", "http://localhost:3030");
    expect(result).toBe("program credits.aleo;\n");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3030/mainnet/program/credits.aleo",
    );
  });

  it("includes per-network error details when all paths fail", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    try {
      await defaultFetchNetworkDep("missing.aleo", "http://localhost:9999");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("testnet: fetch failed");
      expect(msg).toContain("mainnet: HTTP 404");
      expect(msg).toContain("canary: ECONNREFUSED");
    }
  });

  it("includes HTTP status codes in error details", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    try {
      await defaultFetchNetworkDep("missing.aleo", "http://localhost:3030");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("HTTP 404");
      expect(msg).toContain("testnet: HTTP 404");
      expect(msg).toContain("mainnet: HTTP 404");
      expect(msg).toContain("canary: HTTP 404");
    }
  });

  // --- networkHint ---

  it("tries hinted network first", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve("source"),
    });
    globalThis.fetch = mockFetch;

    await defaultFetchNetworkDep("credits.aleo", "http://localhost:3030", "mainnet");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3030/mainnet/program/credits.aleo");
  });

  it("does not fall back to other networks when hint is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
    globalThis.fetch = mockFetch;

    await expect(
      defaultFetchNetworkDep("credits.aleo", "http://localhost:3030", "mainnet"),
    ).rejects.toThrow(/mainnet: HTTP 404/);

    // Only the hinted network is tried — no cross-network fallback
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3030/mainnet/program/credits.aleo");
  });

  it("falls back across all networks when no hint is given", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 }) // testnet
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("source"),
      }); // mainnet
    globalThis.fetch = mockFetch;

    const result = await defaultFetchNetworkDep("credits.aleo", "http://localhost:3030");
    expect(result).toBe("source");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3030/mainnet/program/credits.aleo",
    );
  });
});

// ---------------------------------------------------------------------------
// Network dependency caching (getCachedNetworkDep / linkNetworkDependency)
// ---------------------------------------------------------------------------

describe("network dep caching", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for an uncached dep", () => {
    expect(getCachedNetworkDep(tmpDir, "credits.aleo", "testnet")).toBeNull();
  });

  it("returns cached content after linkNetworkDependency writes it", () => {
    const pkgDir = path.join(tmpDir, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    linkNetworkDependency(pkgDir, "credits.aleo", "program credits.aleo;\n", tmpDir, "testnet");

    expect(getCachedNetworkDep(tmpDir, "credits.aleo", "testnet")).toBe("program credits.aleo;\n");
  });

  it("copies dep to package imports/ directory", () => {
    const pkgDir = path.join(tmpDir, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    linkNetworkDependency(pkgDir, "credits.aleo", "program credits.aleo;\n", tmpDir, "testnet");

    const importsFile = path.join(pkgDir, "imports", "credits.aleo");
    expect(fs.existsSync(importsFile)).toBe(true);
    expect(fs.readFileSync(importsFile, "utf-8")).toBe("program credits.aleo;\n");
  });

  it("scopes cache by network — testnet cache is invisible to mainnet", () => {
    const pkgDir = path.join(tmpDir, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    linkNetworkDependency(pkgDir, "credits.aleo", "program credits.aleo;\n", tmpDir, "testnet");

    // Same dep, different network scope → cache miss
    expect(getCachedNetworkDep(tmpDir, "credits.aleo", "mainnet")).toBeNull();
    // Same network scope → cache hit
    expect(getCachedNetworkDep(tmpDir, "credits.aleo", "testnet")).toBe("program credits.aleo;\n");
  });

  it("empty cache file is treated as falsy (triggers re-fetch)", () => {
    // Simulate a corrupted/truncated cache file
    const cachePath = path.join(tmpDir, "network-deps", "testnet", "credits.aleo");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "");

    const result = getCachedNetworkDep(tmpDir, "credits.aleo", "testnet");
    // Empty string is returned — the pipeline treats "" as falsy,
    // so it will re-fetch the dep. This is correct recovery behavior.
    expect(result).toBe("");
    expect(!result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeUnitHash — network dep inclusion
// ---------------------------------------------------------------------------

describe("computeUnitHash with network deps", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-hash-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeUnit(name: string) {
    const srcDir = path.join(tmpDir, "src", name);
    const pkgDir = path.join(tmpDir, "pkg", name);
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "main.leo"), `program ${name}.aleo {}`);
    const unit = {
      kind: "program" as const,
      programId: `${name}.aleo`,
      sourceDir: srcDir,
      entryFile: path.join(srcDir, "main.leo"),
      allSources: ["main.leo"],
    };
    return { unit, srcDir, pkgDir };
  }

  it("changes hash when network dep source changes", () => {
    const { unit, pkgDir } = makeUnit("app");

    // Link network dep with source v1
    const importsDir = path.join(pkgDir, "imports");
    fs.mkdirSync(importsDir, { recursive: true });
    fs.writeFileSync(path.join(importsDir, "credits.aleo"), "program credits.aleo; // v1\n");

    const hash1 = computeUnitHash(unit, pkgDir, [], new Map(), ["credits.aleo"]);

    // Update network dep source to v2
    fs.writeFileSync(path.join(importsDir, "credits.aleo"), "program credits.aleo; // v2\n");

    const hash2 = computeUnitHash(unit, pkgDir, [], new Map(), ["credits.aleo"]);

    expect(hash1).not.toBe(hash2);
  });

  it("produces same hash when network dep source is unchanged", () => {
    const { unit, pkgDir } = makeUnit("app");

    const importsDir = path.join(pkgDir, "imports");
    fs.mkdirSync(importsDir, { recursive: true });
    fs.writeFileSync(path.join(importsDir, "credits.aleo"), "program credits.aleo;\n");

    const hash1 = computeUnitHash(unit, pkgDir, [], new Map(), ["credits.aleo"]);
    const hash2 = computeUnitHash(unit, pkgDir, [], new Map(), ["credits.aleo"]);

    expect(hash1).toBe(hash2);
  });

  it("hash without network deps differs from hash with network deps", () => {
    const { unit, pkgDir } = makeUnit("app");

    const importsDir = path.join(pkgDir, "imports");
    fs.mkdirSync(importsDir, { recursive: true });
    fs.writeFileSync(path.join(importsDir, "credits.aleo"), "program credits.aleo;\n");

    const hashWithout = computeUnitHash(unit, pkgDir, [], new Map());
    const hashWith = computeUnitHash(unit, pkgDir, [], new Map(), ["credits.aleo"]);

    expect(hashWithout).not.toBe(hashWith);
  });
});

// ---------------------------------------------------------------------------
// compilePipeline — network dep integration
//
// These tests call compilePipeline with real temp directories and an injected
// fetchNetworkDep spy. The pipeline will fail at `leo build` (not installed
// in test env), but the fetch step runs before compilation, so we can verify
// the spy was called with the correct arguments.
// ---------------------------------------------------------------------------

describe("compilePipeline network dep handling", () => {
  let tmpDir: string;
  let programsDir: string;
  let artifactsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-pipeline-test-"));
    programsDir = path.join(tmpDir, "programs");
    artifactsDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(programsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProgram(name: string, content: string): void {
    const dir = path.join(programsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "main.leo"), content);
  }

  function makeConfig(overrides?: Partial<LionDenResolvedConfig>): LionDenResolvedConfig {
    return {
      leoVersion: "4.0.0",
      skipLeoVersionCheck: false,
      leoBinary: "leo",
      paths: {
        root: tmpDir,
        programs: programsDir,
        artifacts: artifactsDir,
        typechain: path.join(tmpDir, "typechain"),
        cache: path.join(tmpDir, ".cache"),
        deployments: path.join(tmpDir, "deployments"),
      },
      networks: {
        devnode: {
          type: "devnode" as const,
          socketAddr: "127.0.0.1:3030",
          autoBlock: true,
          verbosity: 0,
          accounts: [],
          network: "testnet" as const,
          ephemeral: true,
        },
      },
      defaultNetwork: "devnode",
      compiler: {
        enableDce: true,
        conditionalBlockMaxDepth: 10,
        buildTests: false,
        extraFlags: [],
      },
      codegen: { enabled: false, outDir: "typechain", dynamicRecords: {} },
      testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
      deploy: {
        defaultPriorityFee: 0,
        privateFee: false,
        confirmTransactions: true,
        confirmationTimeout: 60_000,
        deploymentsDir: "deployments",
        skipDeployed: true,
        autoExport: false,
      },
      sdk: { keyCache: { storage: "memory" } },
      execution: { imports: {} },
      namedAccounts: {},
      ...overrides,
    };
  }

  function readLogLines(logPath: string): string[] {
    return fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean)
      : [];
  }

  it("throws the public UnitNameCollisionError for duplicate program IDs", async () => {
    writeProgram("first/token", "program token.aleo {\n  fn main() {}\n}\n");
    writeProgram("second/token", "program token.aleo {\n  fn main() {}\n}\n");

    await expect(compilePipeline(makeConfig())).rejects.toThrow(UnitNameCollisionError);
  });

  it("validates all program folders before applying a program filter", async () => {
    writeProgram("good", "program good.aleo {\n  fn main() {}\n}\n");
    writeProgram("bad_folder", "program bad_decl.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    const leoPath = path.join(binDir, "leo");
    const sentinelPath = path.join(tmpDir, "leo-invoked");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      leoPath,
      ["#!/bin/sh", 'printf invoked > "$LIONDEN_LEO_SENTINEL"'].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalSentinel = process.env.LIONDEN_LEO_SENTINEL;
    process.env.LIONDEN_LEO_SENTINEL = sentinelPath;

    try {
      await compilePipeline(makeConfig({ leoBinary: leoPath }), {
        program: "good",
        noTypechain: true,
      });
      expect.unreachable("program-folder validation should fail before invoking Leo");
    } catch (err) {
      expect(err).toBeInstanceOf(ProgramFolderNameMismatchError);
      expect((err as Error).message).toMatch(/bad_folder.*bad_decl\.aleo/s);
      expect(fs.existsSync(sentinelPath)).toBe(false);
    } finally {
      if (originalSentinel === undefined) {
        delete process.env.LIONDEN_LEO_SENTINEL;
      } else {
        process.env.LIONDEN_LEO_SENTINEL = originalSentinel;
      }
    }
  });

  it("fails fast on a missing program declaration before applying a program filter", async () => {
    writeProgram("good", "program good.aleo {\n  fn main() {}\n}\n");
    // main.leo with no parseable `program <name>.aleo` declaration anywhere.
    writeProgram("broken", "fn helper() -> u32 { return 1u32; }\n");

    const binDir = path.join(tmpDir, "bin");
    const leoPath = path.join(binDir, "leo");
    const sentinelPath = path.join(tmpDir, "leo-invoked");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      leoPath,
      ["#!/bin/sh", 'printf invoked > "$LIONDEN_LEO_SENTINEL"'].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalSentinel = process.env.LIONDEN_LEO_SENTINEL;
    process.env.LIONDEN_LEO_SENTINEL = sentinelPath;

    try {
      await compilePipeline(makeConfig({ leoBinary: leoPath }), {
        program: "good",
        noTypechain: true,
      });
      expect.unreachable("missing-declaration validation should fail before invoking Leo");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingProgramDeclarationError);
      expect((err as Error).message).toMatch(/broken[/\\]main\.leo is missing a program/s);
      expect(fs.existsSync(sentinelPath)).toBe(false);
    } finally {
      if (originalSentinel === undefined) {
        delete process.env.LIONDEN_LEO_SENTINEL;
      } else {
        process.env.LIONDEN_LEO_SENTINEL = originalSentinel;
      }
    }
  });

  it("passes --disable-update-check before build", async () => {
    writeProgram("app", "program app.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    const argsLog = path.join(tmpDir, "leo-args.log");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" > "$LIONDEN_LEO_ARGS_LOG"',
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'mkdir -p "$pkg/build"',
        'printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' "$id" > "$pkg/build/abi.json"',
        'printf \'program %s {}\\n\' "$id" > "$pkg/build/main.aleo"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    const originalLog = process.env.LIONDEN_LEO_ARGS_LOG;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.LIONDEN_LEO_ARGS_LOG = argsLog;

    try {
      await compilePipeline(makeConfig());

      const args = fs.readFileSync(argsLog, "utf-8").trim().split("\n");
      expect(args.slice(0, 2)).toEqual(["--disable-update-check", "build"]);
      expect(
        readKeyArtifactsMetadata(keyArtifactsMetadataPath(artifactsDir, "app.aleo")),
      ).toMatchObject({
        format: "lionden.keyArtifacts.v1",
        programId: "app.aleo",
        sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        importsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) {
        delete process.env.LIONDEN_LEO_ARGS_LOG;
      } else {
        process.env.LIONDEN_LEO_ARGS_LOG = originalLog;
      }
    }
  });

  it("gates --enable-dce / --conditional-block-max-depth on Leo < 4.2", async () => {
    writeProgram("app", "program app.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    const argsLog = path.join(tmpDir, "leo-args.log");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" > "$LIONDEN_LEO_ARGS_LOG"',
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'mkdir -p "$pkg/build"',
        'printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' "$id" > "$pkg/build/abi.json"',
        'printf \'program %s {}\\n\' "$id" > "$pkg/build/main.aleo"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    const originalLog = process.env.LIONDEN_LEO_ARGS_LOG;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.LIONDEN_LEO_ARGS_LOG = argsLog;

    // The depth flag only appears when set away from its default of 10.
    const compilerOverride = {
      enableDce: true,
      conditionalBlockMaxDepth: 5,
      buildTests: false,
      extraFlags: [],
    };

    try {
      // Leo 4.1 still exposes both flags → they are forwarded. `force` bypasses
      // the compile cache (which keys on source only, not leoVersion) so leo is
      // actually invoked and re-logs its argv on each run.
      await compilePipeline(makeConfig({ leoVersion: "4.1.0", compiler: compilerOverride }), {
        noTypechain: true,
        force: true,
      });
      const v41Args = readLogLines(argsLog);
      expect(v41Args).toContain("--enable-dce");
      expect(v41Args).toContain("--conditional-block-max-depth");

      // Leo 4.2 removed both flags → they must be omitted (else the build hard-fails
      // with "unexpected argument").
      fs.rmSync(argsLog, { force: true });
      await compilePipeline(makeConfig({ leoVersion: "4.2.0", compiler: compilerOverride }), {
        noTypechain: true,
        force: true,
      });
      const v42Args = readLogLines(argsLog);
      expect(v42Args).not.toContain("--enable-dce");
      expect(v42Args).not.toContain("--conditional-block-max-depth");
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) {
        delete process.env.LIONDEN_LEO_ARGS_LOG;
      } else {
        process.env.LIONDEN_LEO_ARGS_LOG = originalLog;
      }
    }
  });

  it("records unambiguous prover and verifier artifact refs in the sidecar", async () => {
    writeProgram("app", "program app.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'mkdir -p "$pkg/build"',
        'printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[{"name":"main","inputs":[],"outputs":[]}]}\\n\' "$id" > "$pkg/build/abi.json"',
        'printf \'program %s {}\\n\' "$id" > "$pkg/build/main.aleo"',
        "printf 'prover' > \"$pkg/build/main.prover\"",
        "printf 'verifier' > \"$pkg/build/main.verifier\"",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      await compilePipeline(makeConfig());

      const sidecar = readKeyArtifactsMetadata(keyArtifactsMetadataPath(artifactsDir, "app.aleo"));
      expect(sidecar?.functions).toHaveLength(1);
      expect(sidecar?.functions?.[0]).toMatchObject({
        transition: "main",
        prover: { path: "main.prover" },
        verifier: { path: "main.verifier" },
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("normalizes Leo 4.1 per-unit build layout into LionDen artifacts", async () => {
    writeProgram("app", "program app.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'mkdir -p "$pkg/build"',
        'printf \'{"program":"stale.aleo","functions":[]}\\n\' > "$pkg/build/abi.json"',
        "printf 'program stale.aleo {}\\n' > \"$pkg/build/main.aleo\"",
        'touch -t 202001010000 "$pkg/build/abi.json" "$pkg/build/main.aleo"',
        'unit="$pkg/build/$id"',
        'mkdir -p "$unit/interfaces"',
        'printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[{"name":"main","inputs":[],"outputs":[]}]}\\n\' "$id" > "$unit/abi.json"',
        'printf \'program %s {}\\n\' "$id" > "$unit/$id"',
        "printf 'prover' > \"$unit/main.prover\"",
        "printf 'verifier' > \"$unit/main.verifier\"",
        'printf \'{"program":"reader.aleo"}\\n\' > "$unit/interfaces/reader.abi.json"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const result = await compilePipeline(makeConfig());
      const artifactDir = path.join(artifactsDir, "app.aleo");

      expect(fs.readFileSync(path.join(artifactDir, "abi.json"), "utf-8")).toContain(
        '"program":"app.aleo"',
      );
      expect(fs.readFileSync(path.join(artifactDir, "main.aleo"), "utf-8")).toBe(
        "program app.aleo {}\n",
      );
      expect(fs.existsSync(path.join(artifactDir, "interfaces", "reader.abi.json"))).toBe(true);
      expect(result.results[0]?.unit.kind).toBe("program");
      expect((result.results[0] as any).aleoSource).toBe(path.join(artifactDir, "main.aleo"));

      const sidecar = readKeyArtifactsMetadata(keyArtifactsMetadataPath(artifactsDir, "app.aleo"));
      expect(sidecar?.functions?.[0]).toMatchObject({
        transition: "main",
        prover: { path: "main.prover" },
        verifier: { path: "main.verifier" },
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("prefers root or exact unit artifacts over newer sibling build directories", async () => {
    writeProgram("app", "program app.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'unit="$pkg/build/$id"',
        'other="$pkg/build/other.aleo"',
        'mkdir -p "$unit" "$other"',
        'printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' "$id" > "$unit/abi.json"',
        'printf \'program %s {}\\n\' "$id" > "$unit/$id"',
        'touch -t 202001010000 "$unit/abi.json" "$unit/$id"',
        'printf \'{"program":"other.aleo","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' > "$other/abi.json"',
        "printf 'program other.aleo {}\\n' > \"$other/other.aleo\"",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      await compilePipeline(makeConfig());
      const artifactDir = path.join(artifactsDir, "app.aleo");

      expect(fs.readFileSync(path.join(artifactDir, "abi.json"), "utf-8")).toContain(
        '"program":"app.aleo"',
      );
      expect(fs.readFileSync(path.join(artifactDir, "main.aleo"), "utf-8")).toBe(
        "program app.aleo {}\n",
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("compiles a program that depends on a lib.leo library without staging it into imports/", async () => {
    // Inline-`fn` libraries emit no `.aleo`: `leo build` inlines their source
    // (resolved from the library's package `path` in program.json) into the
    // dependent's bytecode. LionDen stages nothing into the dependent's
    // imports/ for a local dependency. This asserts the honest behavior:
    // the library's build/ is empty, the dependent still compiles, and its
    // imports/ never receives a library file.
    const libDir = path.join(programsDir, "utils");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, "lib.leo"), "fn helper() {}\n");
    writeProgram(
      "app",
      "import utils.aleo;\nprogram app.aleo {\n  fn main() { utils.aleo::helper(); }\n}\n",
    );

    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'unit="$pkg/build/$id"',
        'mkdir -p "$unit"',
        'if [ "$id" = "utils" ]; then',
        "  # Inline-fn library: leo emits no .aleo; build/ stays empty.",
        "  exit 0",
        "fi",
        // The dependent compiles regardless of imports/ contents — leo resolves
        // the library from its program.json `path`, not from a staged file.
        '  printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' "$id" > "$unit/abi.json"',
        '  printf \'program %s {}\\n\' "$id" > "$unit/$id"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      await compilePipeline(makeConfig());

      // The dependent program compiled even though the library emitted no .aleo.
      const artifactDir = path.join(artifactsDir, "app.aleo");
      expect(fs.readFileSync(path.join(artifactDir, "main.aleo"), "utf-8")).toBe(
        "program app.aleo {}\n",
      );

      // No library file was staged into the dependent package's imports/.
      // materializePackage still mkdirs imports/, so it exists but is empty.
      const appImportsDir = path.join(artifactsDir, ".build", "app.aleo", "imports");
      expect(fs.existsSync(path.join(appImportsDir, "utils.aleo"))).toBe(false);
      expect(fs.readdirSync(appImportsDir)).toEqual([]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("does not fall back to sibling build directories when expected artifacts are missing", async () => {
    writeProgram("app", "program app.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'other="$pkg/build/other.aleo"',
        'mkdir -p "$other"',
        'printf \'{"program":"other.aleo","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' > "$other/abi.json"',
        "printf 'program other.aleo {}\\n' > \"$other/other.aleo\"",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      await expect(compilePipeline(makeConfig())).rejects.toThrow(
        /ABI file not found under .*build/,
      );
      expect(fs.existsSync(path.join(artifactsDir, "app.aleo", "abi.json"))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("does not cache a successful leo build until artifact validation succeeds", async () => {
    writeProgram("app", "program app.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    const invocationsLog = path.join(tmpDir, "leo-invocations.log");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'printf \'%s\\n\' "$id" >> "$LIONDEN_LEO_INVOCATIONS_LOG"',
        'invocation=$(wc -l < "$LIONDEN_LEO_INVOCATIONS_LOG")',
        'mkdir -p "$pkg/build"',
        'printf \'program %s {}\\n\' "$id" > "$pkg/build/main.aleo"',
        'if [ "$invocation" -gt 1 ]; then',
        '  printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[{"name":"main","inputs":[],"outputs":[]}]}\\n\' "$id" > "$pkg/build/abi.json"',
        "fi",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    const originalLog = process.env.LIONDEN_LEO_INVOCATIONS_LOG;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.LIONDEN_LEO_INVOCATIONS_LOG = invocationsLog;

    try {
      await expect(compilePipeline(makeConfig())).rejects.toThrow(
        /ABI file not found under .*build/,
      );

      const second = await compilePipeline(makeConfig());

      expect(fs.readFileSync(invocationsLog, "utf-8").trim().split("\n")).toEqual([
        "app.aleo",
        "app.aleo",
      ]);
      expect(second.results[0]?.cached).toBe(false);
      expect(fs.existsSync(path.join(artifactsDir, "app.aleo", "abi.json"))).toBe(true);
      expect(fs.existsSync(path.join(artifactsDir, "app.aleo", "main.aleo"))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) {
        delete process.env.LIONDEN_LEO_INVOCATIONS_LOG;
      } else {
        process.env.LIONDEN_LEO_INVOCATIONS_LOG = originalLog;
      }
    }
  });

  it("rejects an ABI from the expected location when it belongs to another program", async () => {
    writeProgram("app", "program app.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'unit="$pkg/build/$id"',
        'mkdir -p "$unit"',
        'printf \'{"program":"other.aleo","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' > "$unit/abi.json"',
        'printf \'program %s {}\\n\' "$id" > "$unit/$id"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      try {
        await compilePipeline(makeConfig());
        expect.unreachable("should have rejected the mismatched ABI");
      } catch (err) {
        expect(err).toBeInstanceOf(CompilationError);
        expect((err as Error).message).toMatch(
          /Resolved ABI belongs to program "other\.aleo", expected "app\.aleo"/,
        );
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("does not cache a build whose artifacts are present but fail ABI validation", async () => {
    // Regression guard for the writeCache placement: writeCache must run AFTER
    // ABI validation + artifact copy, not right after `leo build`. Here the build
    // emits a COMPLETE artifact set (abi.json + .aleo) every time — so the cache's
    // hasRequiredProgramArtifacts revalidation is satisfied — but the first build's
    // ABI belongs to the wrong program and fails validation. If the failed build
    // were cached, the rerun would short-circuit (cached=true) and keep surfacing
    // the stale wrong ABI without ever rebuilding. The second build emits the
    // correct ABI, so a correct (uncached) pipeline must re-invoke leo and succeed.
    writeProgram("app", "program app.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    const invocationsLog = path.join(tmpDir, "leo-invocations.log");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'printf \'%s\\n\' "$id" >> "$LIONDEN_LEO_INVOCATIONS_LOG"',
        'invocation=$(wc -l < "$LIONDEN_LEO_INVOCATIONS_LOG")',
        'unit="$pkg/build/$id"',
        'mkdir -p "$unit"',
        'printf \'program %s {}\\n\' "$id" > "$unit/$id"',
        // First build emits an ABI for the wrong program; later builds emit the
        // correct one. Both builds leave a full artifact set on disk.
        'if [ "$invocation" -gt 1 ]; then prog="$id"; else prog="other.aleo"; fi',
        '  printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' "$prog" > "$unit/abi.json"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    const originalLog = process.env.LIONDEN_LEO_INVOCATIONS_LOG;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.LIONDEN_LEO_INVOCATIONS_LOG = invocationsLog;

    try {
      await expect(compilePipeline(makeConfig())).rejects.toThrow(
        /Resolved ABI belongs to program "other\.aleo", expected "app\.aleo"/,
      );

      const second = await compilePipeline(makeConfig());

      // The failed first build was not cached, so the rerun rebuilt (two
      // invocations) and produced the corrected ABI rather than reusing the
      // stale one.
      expect(readLogLines(invocationsLog)).toEqual(["app.aleo", "app.aleo"]);
      expect(second.results[0]?.cached).toBe(false);
      const abiPath = path.join(artifactsDir, "app.aleo", "abi.json");
      expect(fs.existsSync(abiPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(abiPath, "utf-8")).program).toBe("app.aleo");
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) {
        delete process.env.LIONDEN_LEO_INVOCATIONS_LOG;
      } else {
        process.env.LIONDEN_LEO_INVOCATIONS_LOG = originalLog;
      }
    }
  });

  it("links local dependencies from normalized artifacts", async () => {
    const libDir = path.join(programsDir, "utils");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, "lib.leo"), "fn helper() {}\n");
    writeProgram(
      "app",
      "import utils.aleo;\nprogram app.aleo {\n  fn main() { utils.aleo::helper(); }\n}\n",
    );

    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'unit="$pkg/build/$id"',
        'mkdir -p "$unit"',
        'if [ "$id" = "utils" ]; then',
        "  # Inline-fn library: leo emits no .aleo; build/ stays empty.",
        "  exit 0",
        "fi",
        // The dependent compiles regardless of imports/ contents — leo resolves
        // the library from its program.json `path`, not from a staged file.
        '  printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' "$id" > "$unit/abi.json"',
        '  printf \'program %s {}\\n\' "$id" > "$unit/$id"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      await compilePipeline(makeConfig());

      // The dependent program compiled even though the library emitted no .aleo.
      const artifactDir = path.join(artifactsDir, "app.aleo");
      expect(fs.readFileSync(path.join(artifactDir, "main.aleo"), "utf-8")).toBe(
        "program app.aleo {}\n",
      );

      // No library file was staged into the dependent package's imports/.
      // materializePackage still mkdirs imports/, so it exists but is empty.
      const appImportsDir = path.join(artifactsDir, ".build", "app.aleo", "imports");
      expect(fs.existsSync(path.join(appImportsDir, "utils.aleo"))).toBe(false);
      expect(fs.readdirSync(appImportsDir)).toEqual([]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("rebuilds a cached program when preserved build artifacts are missing", async () => {
    writeProgram("app", "program app.aleo {\n  fn main() {}\n}\n");

    const binDir = path.join(tmpDir, "bin");
    const leoPath = path.join(binDir, "leo");
    const buildLog = path.join(tmpDir, "leo-build.log");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      leoPath,
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'printf \'%s\\n\' "$id" >> "$LIONDEN_LEO_BUILD_LOG"',
        'unit="$pkg/build/$id"',
        'mkdir -p "$unit"',
        'printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' "$id" > "$unit/abi.json"',
        'printf \'program %s {}\\n\' "$id" > "$unit/$id"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalLog = process.env.LIONDEN_LEO_BUILD_LOG;
    process.env.LIONDEN_LEO_BUILD_LOG = buildLog;

    try {
      const config = makeConfig({ leoBinary: leoPath });

      const first = await compilePipeline(config);
      expect(first.results[0]?.cached).toBe(false);
      expect(readLogLines(buildLog)).toEqual(["app.aleo"]);

      fs.rmSync(path.join(artifactsDir, ".build", "app.aleo", "build"), {
        recursive: true,
        force: true,
      });

      const second = await compilePipeline(config);

      expect(second.results[0]?.cached).toBe(false);
      expect(readLogLines(buildLog)).toEqual(["app.aleo", "app.aleo"]);
      expect(fs.existsSync(path.join(artifactsDir, "app.aleo", "main.aleo"))).toBe(true);
    } finally {
      if (originalLog === undefined) {
        delete process.env.LIONDEN_LEO_BUILD_LOG;
      } else {
        process.env.LIONDEN_LEO_BUILD_LOG = originalLog;
      }
    }
  });

  it("compiles an inline-fn library that emits no build artifacts and caches it", async () => {
    // Real libraries (e.g. examples/multi-program math_utils) are inline `fn`
    // helpers with no `program` block, so `leo build` produces an empty build/
    // dir with no .aleo. The pipeline must not require .aleo output for
    // libraries, and a hash hit must serve them from cache (nothing to
    // revalidate) rather than erroring on a missing artifact.
    const libDir = path.join(programsDir, "utils");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, "lib.leo"), "fn helper() {}\n");

    const binDir = path.join(tmpDir, "bin");
    const leoPath = path.join(binDir, "leo");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      leoPath,
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        // Inline-fn libraries compile to an empty build/ unit dir — no .aleo.
        'mkdir -p "$pkg/build/$id"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const config = makeConfig({ leoBinary: leoPath });

    const first = await compilePipeline(config);
    const firstLib = first.results.find((result) => result.unit.kind === "library");
    expect(firstLib?.cached).toBe(false);

    const second = await compilePipeline(config);
    const secondLib = second.results.find((result) => result.unit.kind === "library");
    expect(secondLib?.cached).toBe(true);
  });

  it("passes config network as hint to fetchNetworkDep", async () => {
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo;\n");

    try {
      await compilePipeline(makeConfig(), {}, fetchSpy);
    } catch {
      // leo build will fail — we only care about the fetch call
    }

    expect(fetchSpy).toHaveBeenCalledWith("credits.aleo", "http://127.0.0.1:3030", "testnet");
  });

  it("retargets the network-dep fetch to an explicit options.network override", async () => {
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo;\n");
    const config = makeConfig({
      networks: {
        devnode: {
          type: "devnode" as const,
          socketAddr: "127.0.0.1:3030",
          autoBlock: true,
          verbosity: 0,
          accounts: [],
          network: "testnet" as const,
          ephemeral: true,
        },
        alt: {
          type: "http" as const,
          endpoint: "https://api.explorer.provable.com/v1",
          network: "mainnet" as const,
          ephemeral: false,
        },
      },
      defaultNetwork: "devnode",
    });

    try {
      await compilePipeline(config, { network: "alt" }, fetchSpy);
    } catch {
      // leo build will fail
    }

    // The override retargets the fetch to alt's endpoint + network hint — NOT
    // the default devnode/testnet that a bare run would use.
    expect(fetchSpy).toHaveBeenCalledWith(
      "credits.aleo",
      "https://api.explorer.provable.com/v1",
      "mainnet",
    );
  });

  it("uses defaultNetwork for the network-dep fetch when no override is given", async () => {
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo;\n");
    const config = makeConfig({
      networks: {
        devnode: {
          type: "devnode" as const,
          socketAddr: "127.0.0.1:3030",
          autoBlock: true,
          verbosity: 0,
          accounts: [],
          network: "testnet" as const,
          ephemeral: true,
        },
        alt: {
          type: "http" as const,
          endpoint: "https://api.explorer.provable.com/v1",
          network: "mainnet" as const,
          ephemeral: false,
        },
      },
      defaultNetwork: "devnode",
    });

    try {
      await compilePipeline(config, {}, fetchSpy);
    } catch {
      // leo build will fail
    }

    // No override → fetch follows config.defaultNetwork (devnode/testnet).
    expect(fetchSpy).toHaveBeenCalledWith("credits.aleo", "http://127.0.0.1:3030", "testnet");
  });

  it("throws a clear error when options.network is not defined in config", async () => {
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    const fetchSpy = vi.fn();

    await expect(compilePipeline(makeConfig(), { network: "ghost" }, fetchSpy)).rejects.toThrow(
      /Network "ghost" is not defined in config\.networks.*Available networks: devnode/s,
    );
    // Validation happens before any fetch — an unknown network never falls into
    // the localhost endpoint fallback.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws for an explicit empty-string network instead of falling back to localhost", async () => {
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    const fetchSpy = vi.fn();

    // An explicit `""` is *present* but unknown — it must be rejected, not
    // skipped (truthiness) and silently resolved to the `127.0.0.1:3030` fallback.
    await expect(compilePipeline(makeConfig(), { network: "" }, fetchSpy)).rejects.toThrow(
      /Network "" is not defined in config\.networks.*Available networks: devnode/s,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes http endpoint and network when defaultNetwork is http", async () => {
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo;\n");
    const config = makeConfig({
      networks: {
        prod: {
          type: "http" as const,
          endpoint: "https://api.explorer.provable.com/v1",
          network: "mainnet" as const,
          ephemeral: false,
        },
      },
      defaultNetwork: "prod",
    });

    try {
      await compilePipeline(config, {}, fetchSpy);
    } catch {
      // leo build will fail
    }

    expect(fetchSpy).toHaveBeenCalledWith(
      "credits.aleo",
      "https://api.explorer.provable.com/v1",
      "mainnet",
    );
  });

  it("bypasses cache and calls fetcher when force is true", async () => {
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    // Pre-populate cache at the network+endpoint-scoped path
    const scope = cacheScope("testnet", "http://127.0.0.1:3030");
    const cacheScopeDir = path.join(artifactsDir, ".cache", "network-deps", scope);
    fs.mkdirSync(cacheScopeDir, { recursive: true });
    fs.writeFileSync(path.join(cacheScopeDir, "credits.aleo"), "program credits.aleo;\n");

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo;\n");

    try {
      await compilePipeline(makeConfig(), { force: true }, fetchSpy);
    } catch {
      // leo build will fail
    }

    // Fetcher must be called despite cache existing
    expect(fetchSpy).toHaveBeenCalledWith("credits.aleo", "http://127.0.0.1:3030", "testnet");
  });

  it("uses cache and does not call fetcher when force is false", async () => {
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    // Pre-populate cache at the network+endpoint-scoped path
    const scope = cacheScope("testnet", "http://127.0.0.1:3030");
    const cacheScopeDir = path.join(artifactsDir, ".cache", "network-deps", scope);
    fs.mkdirSync(cacheScopeDir, { recursive: true });
    fs.writeFileSync(path.join(cacheScopeDir, "credits.aleo"), "program credits.aleo;\n");

    const fetchSpy = vi.fn();

    try {
      await compilePipeline(makeConfig(), {}, fetchSpy);
    } catch {
      // leo build will fail
    }

    // Fetcher must NOT be called — cache was used
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not reuse testnet cache when switching to mainnet", async () => {
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    // Pre-populate cache under devnode/testnet scope
    const devnodeScope = cacheScope("testnet", "http://127.0.0.1:3030");
    const devnodeCache = path.join(artifactsDir, ".cache", "network-deps", devnodeScope);
    fs.mkdirSync(devnodeCache, { recursive: true });
    fs.writeFileSync(
      path.join(devnodeCache, "credits.aleo"),
      "program credits.aleo; // devnode version\n",
    );

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo; // mainnet version\n");
    const config = makeConfig({
      networks: {
        prod: {
          type: "http" as const,
          endpoint: "https://api.explorer.provable.com/v1",
          network: "mainnet" as const,
          ephemeral: false,
        },
      },
      defaultNetwork: "prod",
    });

    try {
      await compilePipeline(config, {}, fetchSpy);
    } catch {
      // leo build will fail
    }

    // Devnode/testnet cache must not be reused — fetcher must be called for mainnet
    expect(fetchSpy).toHaveBeenCalledWith(
      "credits.aleo",
      "https://api.explorer.provable.com/v1",
      "mainnet",
    );
  });

  it("does not reuse devnode cache when switching to HTTP testnet", async () => {
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    // Pre-populate cache under devnode/testnet scope (localhost)
    const devnodeScope = cacheScope("testnet", "http://127.0.0.1:3030");
    const devnodeCache = path.join(artifactsDir, ".cache", "network-deps", devnodeScope);
    fs.mkdirSync(devnodeCache, { recursive: true });
    fs.writeFileSync(
      path.join(devnodeCache, "credits.aleo"),
      "program credits.aleo; // devnode version\n",
    );

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo; // real testnet version\n");
    const config = makeConfig({
      networks: {
        testnet_http: {
          type: "http" as const,
          endpoint: "https://api.explorer.provable.com/v1",
          network: "testnet" as const,
          ephemeral: false,
        },
      },
      defaultNetwork: "testnet_http",
    });

    try {
      await compilePipeline(config, {}, fetchSpy);
    } catch {
      // leo build will fail
    }

    // Same network ("testnet") but different endpoint — must not reuse devnode cache
    expect(fetchSpy).toHaveBeenCalledWith(
      "credits.aleo",
      "https://api.explorer.provable.com/v1",
      "testnet",
    );
  });

  it("does not fetch network deps for unselected programs", async () => {
    writeProgram("app_prog", "program app_prog.aleo {\n  fn main() {}\n}\n");
    writeProgram(
      "other_prog",
      "import credits.aleo;\nprogram other_prog.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo;\n");

    try {
      await compilePipeline(makeConfig(), { program: "app_prog" }, fetchSpy);
    } catch {
      // leo build will fail
    }

    // app_prog does not import credits.aleo — fetcher must not be called
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hinted fetch does not cache cross-network fallback source under wrong scope", async () => {
    // Regression: when hint is provided, only that network is tried.
    // This prevents a scenario where testnet source could be cached under
    // a mainnet scope key (poisoning future mainnet compiles).
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    // Simulate: mainnet fetch fails on first pipeline run
    const mainnetEndpoint = "https://api.explorer.provable.com/v1";
    const failingSpy = vi.fn().mockRejectedValue(new Error("HTTP 404"));
    const mainnetConfig = makeConfig({
      networks: {
        prod: {
          type: "http" as const,
          endpoint: mainnetEndpoint,
          network: "mainnet" as const,
          ephemeral: false,
        },
      },
      defaultNetwork: "prod",
    });

    try {
      await compilePipeline(mainnetConfig, {}, failingSpy);
    } catch {
      // Expected: fetch fails → compilePipeline throws
    }

    // Cache must remain empty for this scope — no cross-network fallback polluted it
    const mainnetScope = cacheScope("mainnet", mainnetEndpoint);
    expect(
      getCachedNetworkDep(path.join(artifactsDir, ".cache"), "credits.aleo", mainnetScope),
    ).toBeNull();
  });

  it("invalidates compilation cache when network dep source changes", async () => {
    // Regression: network dep source is included in the unit hash. Switching
    // endpoints fetches different source, which must cause a compilation cache
    // miss even when local .leo source is unchanged.
    writeProgram(
      "app",
      "import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n",
    );

    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        'pkg=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--path" ]; then pkg="$arg"; break; fi',
        '  prev="$arg"',
        "done",
        'id=$(basename "$pkg")',
        'mkdir -p "$pkg/build"',
        'printf \'{"program":"%s","structs":[],"records":[],"mappings":[],"storage_variables":[],"functions":[]}\\n\' "$id" > "$pkg/build/abi.json"',
        'printf \'program %s {}\\n\' "$id" > "$pkg/build/main.aleo"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const fetchV1 = vi.fn().mockResolvedValue("program credits.aleo; // devnode v1\n");
      const first = await compilePipeline(makeConfig(), {}, fetchV1);
      expect(fetchV1).toHaveBeenCalled();
      expect(first.results[0]?.cached).toBe(false);

      const fetchV2 = vi.fn().mockResolvedValue("program credits.aleo; // http testnet v2\n");
      const httpTestnetConfig = makeConfig({
        networks: {
          testnet_http: {
            type: "http" as const,
            endpoint: "https://api.explorer.provable.com/v1",
            network: "testnet" as const,
            ephemeral: false,
          },
        },
        defaultNetwork: "testnet_http",
      });

      const second = await compilePipeline(httpTestnetConfig, {}, fetchV2);

      // Different endpoint scope causes a network cache miss.
      expect(fetchV2).toHaveBeenCalledWith(
        "credits.aleo",
        "https://api.explorer.provable.com/v1",
        "testnet",
      );

      // Different linked network source changes the unit hash, so the
      // compilation cache must not be reused.
      expect(second.results[0]?.cached).toBe(false);

      const appPkgDir = path.join(artifactsDir, ".build", "app.aleo");
      const linkedSource = fs.readFileSync(
        path.join(appPkgDir, "imports", "credits.aleo"),
        "utf-8",
      );
      expect(linkedSource).toContain("http testnet v2");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
