import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { LionDenResolvedConfig } from "@lionden/config";
import { defaultFetchNetworkDep, compilePipeline } from "./compiler.js";
import {
  getCachedNetworkDep,
  linkNetworkDependency,
} from "./package-materializer.js";
import { computeUnitHash } from "./cache.js";

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

    const result = await defaultFetchNetworkDep(
      "credits.aleo",
      "http://localhost:3030",
    );
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

    const result = await defaultFetchNetworkDep(
      "credits.aleo",
      "http://localhost:3030",
    );
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
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404 });

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

    await defaultFetchNetworkDep(
      "credits.aleo",
      "http://localhost:3030",
      "mainnet",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3030/mainnet/program/credits.aleo",
    );
  });

  it("does not fall back to other networks when hint is provided", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 });
    globalThis.fetch = mockFetch;

    await expect(
      defaultFetchNetworkDep(
        "credits.aleo",
        "http://localhost:3030",
        "mainnet",
      ),
    ).rejects.toThrow(/mainnet: HTTP 404/);

    // Only the hinted network is tried — no cross-network fallback
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3030/mainnet/program/credits.aleo",
    );
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

    const result = await defaultFetchNetworkDep(
      "credits.aleo",
      "http://localhost:3030",
    );
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

    linkNetworkDependency(
      pkgDir,
      "credits.aleo",
      "program credits.aleo;\n",
      tmpDir,
      "testnet",
    );

    expect(getCachedNetworkDep(tmpDir, "credits.aleo", "testnet")).toBe(
      "program credits.aleo;\n",
    );
  });

  it("copies dep to package imports/ directory", () => {
    const pkgDir = path.join(tmpDir, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    linkNetworkDependency(
      pkgDir,
      "credits.aleo",
      "program credits.aleo;\n",
      tmpDir,
      "testnet",
    );

    const importsFile = path.join(pkgDir, "imports", "credits.aleo");
    expect(fs.existsSync(importsFile)).toBe(true);
    expect(fs.readFileSync(importsFile, "utf-8")).toBe(
      "program credits.aleo;\n",
    );
  });

  it("scopes cache by network — testnet cache is invisible to mainnet", () => {
    const pkgDir = path.join(tmpDir, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    linkNetworkDependency(
      pkgDir,
      "credits.aleo",
      "program credits.aleo;\n",
      tmpDir,
      "testnet",
    );

    // Same dep, different network scope → cache miss
    expect(getCachedNetworkDep(tmpDir, "credits.aleo", "mainnet")).toBeNull();
    // Same network scope → cache hit
    expect(getCachedNetworkDep(tmpDir, "credits.aleo", "testnet")).toBe(
      "program credits.aleo;\n",
    );
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
      leoBinary: "leo",
      paths: {
        root: tmpDir,
        programs: programsDir,
        artifacts: artifactsDir,
        typechain: path.join(tmpDir, "typechain"),
        cache: path.join(tmpDir, ".cache"),
      },
      networks: {
        devnode: {
          type: "devnode" as const,
          socketAddr: "127.0.0.1:3030",
          autoBlock: true,
          verbosity: 0,
          accounts: [],
          network: "testnet" as const,
        },
      },
      defaultNetwork: "devnode",
      compiler: {
        enableDce: true,
        conditionalBlockMaxDepth: 10,
        buildTests: false,
        extraFlags: [],
      },
      codegen: { enabled: false, outDir: "typechain" },
      testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
      deploy: {
        defaultPriorityFee: 0,
        privateFee: false,
        confirmTransactions: true,
        confirmationTimeout: 60_000,
      },
      ...overrides,
    };
  }

  it("passes config network as hint to fetchNetworkDep", async () => {
    writeProgram(
      "app",
      'import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n',
    );

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo;\n");

    try {
      await compilePipeline(makeConfig(), {}, fetchSpy);
    } catch {
      // leo build will fail — we only care about the fetch call
    }

    expect(fetchSpy).toHaveBeenCalledWith(
      "credits.aleo",
      "http://127.0.0.1:3030",
      "testnet",
    );
  });

  it("passes http endpoint and network when defaultNetwork is http", async () => {
    writeProgram(
      "app",
      'import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n',
    );

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo;\n");
    const config = makeConfig({
      networks: {
        prod: {
          type: "http" as const,
          endpoint: "https://api.explorer.provable.com/v1",
          network: "mainnet" as const,
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
      'import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n',
    );

    // Pre-populate cache at the network+endpoint-scoped path
    const scope = cacheScope("testnet", "http://127.0.0.1:3030");
    const cacheScopeDir = path.join(artifactsDir, ".cache", "network-deps", scope);
    fs.mkdirSync(cacheScopeDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheScopeDir, "credits.aleo"),
      "program credits.aleo;\n",
    );

    const fetchSpy = vi.fn().mockResolvedValue("program credits.aleo;\n");

    try {
      await compilePipeline(makeConfig(), { force: true }, fetchSpy);
    } catch {
      // leo build will fail
    }

    // Fetcher must be called despite cache existing
    expect(fetchSpy).toHaveBeenCalledWith(
      "credits.aleo",
      "http://127.0.0.1:3030",
      "testnet",
    );
  });

  it("uses cache and does not call fetcher when force is false", async () => {
    writeProgram(
      "app",
      'import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n',
    );

    // Pre-populate cache at the network+endpoint-scoped path
    const scope = cacheScope("testnet", "http://127.0.0.1:3030");
    const cacheScopeDir = path.join(artifactsDir, ".cache", "network-deps", scope);
    fs.mkdirSync(cacheScopeDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheScopeDir, "credits.aleo"),
      "program credits.aleo;\n",
    );

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
      'import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n',
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
      'import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n',
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
    writeProgram(
      "app_prog",
      "program app_prog.aleo {\n  fn main() {}\n}\n",
    );
    writeProgram(
      "other_prog",
      'import credits.aleo;\nprogram other_prog.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n',
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
      'import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n',
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
    expect(getCachedNetworkDep(
      path.join(artifactsDir, ".cache"),
      "credits.aleo",
      mainnetScope,
    )).toBeNull();
  });

  it("invalidates compilation cache when network dep source changes", async () => {
    // Regression: network dep source is included in the unit hash. Switching
    // endpoints fetches different source, which must cause a compilation cache
    // miss even when local .leo source is unchanged.
    writeProgram(
      "app",
      'import credits.aleo;\nprogram app.aleo {\n  fn main() { credits.aleo::foo(); }\n}\n',
    );

    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "leo"),
      [
        "#!/bin/sh",
        "pkg=\"\"",
        "prev=\"\"",
        "for arg in \"$@\"; do",
        "  if [ \"$prev\" = \"--path\" ]; then pkg=\"$arg\"; break; fi",
        "  prev=\"$arg\"",
        "done",
        "id=$(basename \"$pkg\")",
        "mkdir -p \"$pkg/build\"",
        "printf '{\"program\":\"%s\",\"structs\":[],\"records\":[],\"mappings\":[],\"storage_variables\":[],\"functions\":[]}\\n' \"$id\" > \"$pkg/build/abi.json\"",
        "printf 'program %s {}\\n' \"$id\" > \"$pkg/build/main.aleo\"",
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
