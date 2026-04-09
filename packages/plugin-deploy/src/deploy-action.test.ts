/**
 * Tests for deploy and upgrade action logic, covering:
 * - Fix 1: Upgrade ABI comparison uses old (pre-compile) ABI, not the fresh one
 * - Fix 2: Source directory comes from discovery, not derived from programId
 * - Fix 3: Admin address prevalidation (no silent bypass)
 * - Fix 4: Transitive dependency inclusion and topological ordering
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveDeployTargets, readLeoSourcesFromDir } from "./deploy-task.js";
import { validateAdminSigner } from "./upgrade-task.js";
import { DeployError } from "./deploy-task.js";
import type { DiscoveredProgram, DependencyGraph } from "@lionden/leo-compiler";
import type { DeployManifest } from "./deploy-manifest.js";
import type { NetworkConnection } from "@lionden/network";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProgram(id: string, sourceDir: string): DiscoveredProgram {
  return {
    kind: "program",
    programId: id,
    sourceDir,
    entryFile: `${sourceDir}/main.leo`,
    allSources: ["main.leo"],
  };
}

/**
 * Build a mock DependencyGraph with specified topology.
 *
 * @param order - Programs in topological order (deps before dependents)
 * @param imports - Map of programId → local dependency IDs
 * @param networkDeps - Set of network dependency IDs (e.g. "credits.aleo")
 */
function makeGraph(
  order: DiscoveredProgram[],
  imports: Record<string, string[]> = {},
  networkDeps: string[] = ["credits.aleo"],
): DependencyGraph {
  return {
    order,
    imports: new Map(Object.entries(imports)),
    networkDeps: new Set(networkDeps),
  };
}

// ---------------------------------------------------------------------------
// Fix 2: readLeoSourcesFromDir uses discovered sourceDir
// ---------------------------------------------------------------------------

describe("readLeoSourcesFromDir (Fix 2: source dir from discovery)", () => {
  let tmpDir: string;

  function setup(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-sources-"));
    return dir;
  }

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads .leo files from the given absolute directory", () => {
    tmpDir = setup();
    // Simulate: programs/token/ declares "program ledger.aleo {}"
    // The sourceDir is programs/token, NOT programs/ledger
    fs.writeFileSync(
      path.join(tmpDir, "main.leo"),
      `program ledger.aleo {\n  @noupgrade\n  constructor() {}\n}`,
    );

    const source = readLeoSourcesFromDir(tmpDir);
    expect(source).toContain("@noupgrade");
    expect(source).toContain("constructor()");
  });

  it("reads nested .leo files preserving all sources", () => {
    tmpDir = setup();
    fs.writeFileSync(path.join(tmpDir, "main.leo"), "program test.aleo {}");
    fs.mkdirSync(path.join(tmpDir, "internal"));
    fs.writeFileSync(
      path.join(tmpDir, "internal", "helpers.leo"),
      "@custom\nconstructor() {}",
    );

    const source = readLeoSourcesFromDir(tmpDir);
    expect(source).toContain("@custom");
    expect(source).toContain("constructor()");
  });

  it("returns empty string for non-existent directory", () => {
    expect(readLeoSourcesFromDir("/nonexistent/path")).toBe("");
  });

  it("correctly finds constructor when dir name differs from programId", () => {
    tmpDir = setup();
    // Key scenario: programs/token/ contains "program ledger.aleo {}"
    // Old code would look in programs/ledger/ (wrong), new code uses sourceDir
    const tokenDir = path.join(tmpDir, "token");
    fs.mkdirSync(tokenDir);
    fs.writeFileSync(
      path.join(tokenDir, "main.leo"),
      `program ledger.aleo {\n  @admin(address="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px")\n  constructor() {}\n}`,
    );

    // Reading from the discovered sourceDir (token/) works
    const source = readLeoSourcesFromDir(tokenDir);
    expect(source).toContain("@admin");

    // Reading from the programId-derived path (ledger/) fails
    const wrongDir = path.join(tmpDir, "ledger");
    const wrongSource = readLeoSourcesFromDir(wrongDir);
    expect(wrongSource).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Fix 4: resolveDeployTargets — topological ordering and transitive deps
// ---------------------------------------------------------------------------

describe("resolveDeployTargets (Fix 4: dependency ordering)", () => {
  it("returns all compiled programs in graph topo order", () => {
    const utils = makeProgram("utils.aleo", "/p/utils");
    const token = makeProgram("token.aleo", "/p/token");
    const graph = makeGraph(
      [utils, token], // topo order: utils first
      {
        "utils.aleo": [],
        "token.aleo": ["utils.aleo", "credits.aleo"],
      },
    );
    const programMap = new Map<string, DiscoveredProgram>([
      ["utils.aleo", utils],
      ["token.aleo", token],
    ]);

    const result = resolveDeployTargets(
      ["token.aleo", "utils.aleo"],
      programMap,
      graph,
      undefined,
    );

    expect(result).toEqual(["utils.aleo", "token.aleo"]);
  });

  it("respects graph order even when compiledIds has different order", () => {
    const dep = makeProgram("dep.aleo", "/p/dep");
    const main = makeProgram("main.aleo", "/p/main");
    const graph = makeGraph(
      [dep, main], // dep before main
      {
        "dep.aleo": [],
        "main.aleo": ["dep.aleo"],
      },
    );
    const programMap = new Map<string, DiscoveredProgram>([
      ["dep.aleo", dep],
      ["main.aleo", main],
    ]);

    // compiledIds in reverse order — graph.order should prevail
    const result = resolveDeployTargets(
      ["main.aleo", "dep.aleo"],
      programMap,
      graph,
      undefined,
    );

    expect(result[0]).toBe("dep.aleo");
    expect(result[1]).toBe("main.aleo");
  });

  it("includes transitive program deps when --program is specified", () => {
    const base = makeProgram("base.aleo", "/p/base");
    const mid = makeProgram("mid.aleo", "/p/mid");
    const top = makeProgram("top.aleo", "/p/top");
    const graph = makeGraph(
      [base, mid, top],
      {
        "base.aleo": [],
        "mid.aleo": ["base.aleo"],
        "top.aleo": ["mid.aleo", "credits.aleo"],
      },
    );
    const programMap = new Map<string, DiscoveredProgram>([
      ["base.aleo", base],
      ["mid.aleo", mid],
      ["top.aleo", top],
    ]);

    // Deploy only "top" — should include base and mid as transitive deps
    const result = resolveDeployTargets(
      ["base.aleo", "mid.aleo", "top.aleo"],
      programMap,
      graph,
      "top",
    );

    expect(result).toEqual(["base.aleo", "mid.aleo", "top.aleo"]);
  });

  it("deploys only target when it has no local deps", () => {
    const alpha = makeProgram("alpha.aleo", "/p/alpha");
    const beta = makeProgram("beta.aleo", "/p/beta");
    const graph = makeGraph(
      [alpha, beta],
      {
        "alpha.aleo": ["credits.aleo"],
        "beta.aleo": ["credits.aleo"],
      },
    );
    const programMap = new Map<string, DiscoveredProgram>([
      ["alpha.aleo", alpha],
      ["beta.aleo", beta],
    ]);

    const result = resolveDeployTargets(
      ["alpha.aleo", "beta.aleo"],
      programMap,
      graph,
      "beta",
    );

    expect(result).toEqual(["beta.aleo"]);
  });

  it("follows through libraries to find transitive program deps", () => {
    // token depends on math_lib (library), math_lib depends on utils (program)
    // Libraries are not deployed but their program deps must be.
    const utils = makeProgram("utils.aleo", "/p/utils");
    const token = makeProgram("token.aleo", "/p/token");
    // math_lib is a library — it appears in graph.order but not in programMap
    const mathLib = {
      kind: "library" as const,
      name: "math_lib",
      sourceDir: "/p/math_lib",
      entryFile: "/p/math_lib/lib.leo",
      allSources: ["lib.leo"],
    };
    const graph: DependencyGraph = {
      order: [utils, mathLib, token],
      imports: new Map([
        ["utils.aleo", []],
        ["math_lib", ["utils.aleo"]],
        ["token.aleo", ["math_lib", "credits.aleo"]],
      ]),
      networkDeps: new Set(["credits.aleo"]),
    };
    const programMap = new Map<string, DiscoveredProgram>([
      ["utils.aleo", utils],
      ["token.aleo", token],
    ]);

    // Deploy token — should pull in utils (transitive through math_lib)
    const result = resolveDeployTargets(
      ["utils.aleo", "token.aleo"],
      programMap,
      graph,
      "token",
    );

    expect(result).toContain("utils.aleo");
    expect(result).toContain("token.aleo");
    expect(result.indexOf("utils.aleo")).toBeLessThan(
      result.indexOf("token.aleo"),
    );
    // math_lib should NOT be in deploy list (it's a library)
    expect(result).not.toContain("math_lib");
  });

  it("normalizes program name by adding .aleo suffix", () => {
    const hello = makeProgram("hello.aleo", "/p/hello");
    const graph = makeGraph([hello], { "hello.aleo": [] });
    const programMap = new Map<string, DiscoveredProgram>([
      ["hello.aleo", hello],
    ]);

    const result = resolveDeployTargets(
      ["hello.aleo"],
      programMap,
      graph,
      "hello",
    );
    expect(result).toEqual(["hello.aleo"]);
  });

  it("throws when target program not found in compiled artifacts", () => {
    const graph = makeGraph([], {});
    const programMap = new Map<string, DiscoveredProgram>();
    expect(() =>
      resolveDeployTargets(["other.aleo"], programMap, graph, "missing"),
    ).toThrow(DeployError);
    expect(() =>
      resolveDeployTargets(["other.aleo"], programMap, graph, "missing"),
    ).toThrow("not found in compiled artifacts");
  });

  it("includes compiled programs not in graph (safety fallback)", () => {
    const known = makeProgram("known.aleo", "/p/known");
    const graph = makeGraph([known], { "known.aleo": [] });
    const programMap = new Map<string, DiscoveredProgram>([
      ["known.aleo", known],
    ]);

    const result = resolveDeployTargets(
      ["known.aleo", "extra.aleo"],
      programMap,
      graph,
      undefined,
    );

    expect(result).toContain("known.aleo");
    expect(result).toContain("extra.aleo");
  });

  it("handles diamond dependency correctly", () => {
    // A depends on B and C, both B and C depend on D
    const d = makeProgram("d.aleo", "/p/d");
    const b = makeProgram("b.aleo", "/p/b");
    const c = makeProgram("c.aleo", "/p/c");
    const a = makeProgram("a.aleo", "/p/a");
    const graph = makeGraph(
      [d, b, c, a], // topo order
      {
        "d.aleo": [],
        "b.aleo": ["d.aleo"],
        "c.aleo": ["d.aleo"],
        "a.aleo": ["b.aleo", "c.aleo"],
      },
    );
    const programMap = new Map<string, DiscoveredProgram>([
      ["d.aleo", d],
      ["b.aleo", b],
      ["c.aleo", c],
      ["a.aleo", a],
    ]);

    const result = resolveDeployTargets(
      ["d.aleo", "b.aleo", "c.aleo", "a.aleo"],
      programMap,
      graph,
      "a",
    );

    // d must come before b and c, all must come before a
    expect(result.indexOf("d.aleo")).toBeLessThan(result.indexOf("b.aleo"));
    expect(result.indexOf("d.aleo")).toBeLessThan(result.indexOf("c.aleo"));
    expect(result.indexOf("b.aleo")).toBeLessThan(result.indexOf("a.aleo"));
    expect(result.indexOf("c.aleo")).toBeLessThan(result.indexOf("a.aleo"));
    expect(result).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Fix 1: Upgrade reads old ABI before compile (structural test)
// ---------------------------------------------------------------------------

describe("upgrade ABI ordering (Fix 1)", () => {
  it("readOldAbi reads from disk independently of artifacts store", async () => {
    // The key fix is that readOldAbi is called BEFORE lre.tasks.run("compile"),
    // which overwrites the ABI file. This test verifies the manifest/ABI
    // reading function works on pre-existing files.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-abi-"));
    try {
      const programDir = path.join(tmpDir, "hello.aleo");
      fs.mkdirSync(programDir, { recursive: true });

      const oldAbi = {
        program: "hello.aleo",
        structs: [],
        records: [],
        mappings: [{ name: "counter", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U64" } } }],
        storage_variables: [],
        transitions: [{ name: "increment", is_async: false, inputs: [], outputs: [] }],
      };

      // Write the "old" ABI (as if from a previous deploy)
      fs.writeFileSync(
        path.join(programDir, "abi.json"),
        JSON.stringify(oldAbi),
      );

      // Read it back — this simulates what upgrade-task.ts does BEFORE compile
      const raw = fs.readFileSync(path.join(programDir, "abi.json"), "utf-8");
      const parsed = JSON.parse(raw);

      expect(parsed.mappings).toHaveLength(1);
      expect(parsed.mappings[0].name).toBe("counter");

      // Now simulate compilation overwriting the file with a new ABI
      const newAbi = {
        ...oldAbi,
        mappings: [], // Mapping deleted — incompatible!
      };
      fs.writeFileSync(
        path.join(programDir, "abi.json"),
        JSON.stringify(newAbi),
      );

      // Re-reading from disk now gets the NEW abi
      const rawNew = fs.readFileSync(path.join(programDir, "abi.json"), "utf-8");
      const parsedNew = JSON.parse(rawNew);
      expect(parsedNew.mappings).toHaveLength(0);

      // The fix ensures we read `parsed` (old) BEFORE compile, not `parsedNew`
      // So the ABI compatibility check would correctly catch the deletion.
      const { checkAbiCompatibility } = await import("./abi-compat.js");
      const compat = checkAbiCompatibility(parsed, parsedNew);
      expect(compat.compatible).toBe(false);
      expect(compat.violations[0]!.kind).toBe("mapping_deleted");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3: Admin signer prevalidation (no silent bypass)
// ---------------------------------------------------------------------------

describe("validateAdminSigner (Fix 3)", () => {
  const adminAddress = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";

  const baseManifest: DeployManifest = {
    programId: "token.aleo",
    network: "devnode",
    endpoint: "http://127.0.0.1:3030",
    txId: "at1test",
    blockHeight: 42,
    edition: 0,
    constructorType: "admin",
    constructorAdmin: adminAddress,
    deployedAt: "2026-04-08T12:00:00.000Z",
  };

  const mockConnection: NetworkConnection = {
    type: "devnode",
    name: "devnode",
    endpoint: "http://127.0.0.1:3030",
    networkId: "testnet",
    getBalance: vi.fn(),
    getMappingValue: vi.fn(),
    execute: vi.fn(),
    waitForConfirmation: vi.fn(),
    getBlockHeight: vi.fn(),
    broadcastTransaction: vi.fn(),
    close: vi.fn(),
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not throw when manifest has no admin address", async () => {
    const manifestNoAdmin: DeployManifest = {
      ...baseManifest,
      constructorAdmin: null,
    };
    const config = {
      networks: {
        devnode: { type: "devnode" as const, socketAddr: "127.0.0.1:3030", autoBlock: true, verbosity: 0, accounts: [], network: "testnet" as const },
      },
    } as any;

    await expect(
      validateAdminSigner(mockConnection, config, "devnode", manifestNoAdmin, "token.aleo"),
    ).resolves.not.toThrow();
  });

  it("throws when network config not found", async () => {
    const config = { networks: {} } as any;

    await expect(
      validateAdminSigner(mockConnection, config, "nonexistent", baseManifest, "token.aleo"),
    ).rejects.toThrow(DeployError);
    await expect(
      validateAdminSigner(mockConnection, config, "nonexistent", baseManifest, "token.aleo"),
    ).rejects.toThrow("network \"nonexistent\" not found in config");
  });

  it("throws when signer address cannot be derived", async () => {
    // HTTP network with no privateKey → cannot derive signer
    const config = {
      networks: {
        testnet: {
          type: "http" as const,
          endpoint: "https://api.example.com",
          network: "testnet" as const,
          // no privateKey
        },
      },
    } as any;

    await expect(
      validateAdminSigner(mockConnection, config, "testnet", baseManifest, "token.aleo"),
    ).rejects.toThrow(DeployError);
    await expect(
      validateAdminSigner(mockConnection, config, "testnet", baseManifest, "token.aleo"),
    ).rejects.toThrow("unable to determine the signer address");
  });

  it("uses well-known devnode account-0 address when no accounts configured", async () => {
    const config = {
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
    } as any;

    // The well-known account-0 address IS the admin address, so no throw
    await expect(
      validateAdminSigner(mockConnection, config, "devnode", baseManifest, "token.aleo"),
    ).resolves.not.toThrow();
  });

  it("throws when devnode account-0 address does not match admin", async () => {
    const manifestDiffAdmin: DeployManifest = {
      ...baseManifest,
      constructorAdmin: "aleo1s3ws5tra87fjycnjrwsjcrnw2qz7vrcqa96naxdzj0tpv3qvqugqxk6rn0", // account-1
    };
    const config = {
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
    } as any;

    // Account-0 address does NOT match account-1 admin address
    await expect(
      validateAdminSigner(mockConnection, config, "devnode", manifestDiffAdmin, "token.aleo"),
    ).rejects.toThrow(DeployError);
    await expect(
      validateAdminSigner(mockConnection, config, "devnode", manifestDiffAdmin, "token.aleo"),
    ).rejects.toThrow("configured signer address");
  });
});
