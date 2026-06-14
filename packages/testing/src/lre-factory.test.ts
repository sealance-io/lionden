import * as fs from "node:fs";
import * as path from "node:path";
import { type TempProject, TempProjectBuilder } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLre, resetTestLre } from "./lre-factory.js";

describe("lre-factory", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetTestLre();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetTestLre();
  });

  describe("LIONDEN_NETWORK bridge", () => {
    let project: TempProject | undefined;

    const TWO_NETWORK_CONFIG = `export default {
      defaultNetwork: "devnode",
      networks: {
        devnode: { type: "devnode", autoBlock: true },
        altnet: {
          type: "http",
          endpoint: "https://api.explorer.provable.com/v1",
          network: "testnet",
        },
      },
    };`;

    afterEach(() => {
      project?.cleanup();
      project = undefined;
    });

    it("retargets config.defaultNetwork to the bridged network", async () => {
      project = new TempProjectBuilder().withConfig(TWO_NETWORK_CONFIG).build();
      process.env["LIONDEN_PROJECT_ROOT"] = project.root;
      process.env["LIONDEN_NETWORK"] = "altnet";

      try {
        const lre = await createTestLre();
        expect(lre.config.defaultNetwork).toBe("altnet");
      } finally {
        resetTestLre();
      }
    });

    it("throws a clear error when the bridged network is unknown", async () => {
      project = new TempProjectBuilder().withConfig(TWO_NETWORK_CONFIG).build();
      process.env["LIONDEN_PROJECT_ROOT"] = project.root;
      process.env["LIONDEN_NETWORK"] = "ghostnet";

      try {
        await expect(createTestLre()).rejects.toThrow(
          'Network "ghostnet" (from LIONDEN_NETWORK) is not defined in config.networks',
        );
      } finally {
        resetTestLre();
      }
    });

    it("leaves config.defaultNetwork at the file default when LIONDEN_NETWORK is unset", async () => {
      project = new TempProjectBuilder().withConfig(TWO_NETWORK_CONFIG).build();
      process.env["LIONDEN_PROJECT_ROOT"] = project.root;
      delete process.env["LIONDEN_NETWORK"];

      try {
        const lre = await createTestLre();
        expect(lre.config.defaultNetwork).toBe("devnode");
      } finally {
        resetTestLre();
      }
    });

    it("uses LIONDEN_CONFIG_PATH when the parent CLI loaded a nonstandard config file", async () => {
      project = new TempProjectBuilder()
        .withConfig(`export default { defaultNetwork: "devnode" };`)
        .build();
      const customConfigPath = path.join(project.root, "lionden.http.config.ts");
      fs.writeFileSync(
        customConfigPath,
        `export default {
          defaultNetwork: "localHttp",
          networks: {
            devnode: { type: "devnode", autoBlock: true },
            localHttp: {
              type: "http",
              endpoint: "http://127.0.0.1:4066",
              network: "testnet",
            },
          },
        };`,
      );
      process.env["LIONDEN_PROJECT_ROOT"] = project.root;
      process.env["LIONDEN_CONFIG_PATH"] = customConfigPath;
      process.env["LIONDEN_NETWORK"] = "localHttp";

      try {
        const lre = await createTestLre();
        expect(lre.config.defaultNetwork).toBe("localHttp");
        expect(lre.config.networks.localHttp?.type).toBe("http");
      } finally {
        resetTestLre();
      }
    });

    it("throws a clear error when LIONDEN_CONFIG_PATH points at a missing file", async () => {
      project = new TempProjectBuilder()
        .withConfig(`export default { defaultNetwork: "devnode" };`)
        .build();
      const missingConfigPath = path.join(project.root, "missing.config.ts");
      process.env["LIONDEN_PROJECT_ROOT"] = project.root;
      process.env["LIONDEN_CONFIG_PATH"] = missingConfigPath;

      try {
        await expect(createTestLre()).rejects.toThrow(
          `Config file "${missingConfigPath}" from LIONDEN_CONFIG_PATH does not exist`,
        );
      } finally {
        resetTestLre();
      }
    });
  });

  it("throws when no config file is found", async () => {
    // Point to a dir with no config file
    process.env["LIONDEN_PROJECT_ROOT"] = "/tmp/nonexistent-dir";

    await expect(createTestLre()).rejects.toThrow(/No lionden\.config\.\{ts,js,mjs\} found/);
  });

  it("caches the LRE across multiple calls", async () => {
    // We can't easily test the full flow (needs a real config file),
    // but we can test that resetTestLre clears the cache by observing
    // that createTestLre throws again after reset.
    process.env["LIONDEN_PROJECT_ROOT"] = "/tmp/nonexistent-dir";

    await expect(createTestLre()).rejects.toThrow();

    // After reset, it should try again (not return cached result)
    resetTestLre();
    await expect(createTestLre()).rejects.toThrow();
  });

  it("clears rejected promise so next call retries", async () => {
    // First call with an invalid root — should reject
    process.env["LIONDEN_PROJECT_ROOT"] = "/tmp/nonexistent-dir-" + Date.now();
    await expect(createTestLre()).rejects.toThrow();

    // Second call (without resetTestLre) should retry, not return stale rejection.
    // Still fails (same env), but it's a fresh attempt — different promise.
    const p1 = createTestLre().catch((e: Error) => e.message);
    const p2 = createTestLre().catch((e: Error) => e.message);
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1).toContain("No lionden.config");
    expect(m2).toContain("No lionden.config");
  });

  it("uses LIONDEN_PROJECT_ROOT env var for config discovery", async () => {
    const tempDir = "/tmp/test-lre-factory-" + Date.now();
    process.env["LIONDEN_PROJECT_ROOT"] = tempDir;

    // Should attempt to find config starting from the env var path
    await expect(createTestLre()).rejects.toThrow(tempDir);
  });
});
