import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DeployManifest,
  deployManifestPath,
  readDeployManifest,
  writeDeployManifest,
} from "./deploy-manifest.js";

describe("deploy manifest", () => {
  let tmpDir: string;

  function createTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-deploy-test-"));
    return dir;
  }

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  const sampleManifest: DeployManifest = {
    programId: "hello.aleo",
    network: "devnode",
    endpoint: "http://127.0.0.1:3030",
    txId: "at1test123456789",
    blockHeight: 42,
    edition: 0,
    constructorType: "noupgrade",
    constructorAdmin: null,
    deployedAt: "2026-04-08T12:00:00.000Z",
  };

  it("writes and reads a deploy manifest", () => {
    tmpDir = createTmpDir();

    writeDeployManifest(tmpDir, sampleManifest);

    const read = readDeployManifest(tmpDir, "hello.aleo");
    expect(read).toEqual(sampleManifest);
  });

  it("creates artifact directory if it doesn't exist", () => {
    tmpDir = createTmpDir();
    const deepDir = path.join(tmpDir, "nested", "artifacts");

    writeDeployManifest(deepDir, sampleManifest);

    expect(fs.existsSync(path.join(deepDir, "hello.aleo", "deploy.json"))).toBe(true);
  });

  it("returns null for non-existent manifest", () => {
    tmpDir = createTmpDir();
    expect(readDeployManifest(tmpDir, "nonexistent.aleo")).toBeNull();
  });

  it("overwrites existing manifest on re-deploy", () => {
    tmpDir = createTmpDir();

    writeDeployManifest(tmpDir, sampleManifest);

    const updated: DeployManifest = {
      ...sampleManifest,
      txId: "at1updated999",
      blockHeight: 100,
      edition: 1,
      deployedAt: "2026-04-08T13:00:00.000Z",
    };

    writeDeployManifest(tmpDir, updated);

    const read = readDeployManifest(tmpDir, "hello.aleo");
    expect(read?.txId).toBe("at1updated999");
    expect(read?.edition).toBe(1);
  });

  it("preserves admin constructor info", () => {
    tmpDir = createTmpDir();

    const adminManifest: DeployManifest = {
      ...sampleManifest,
      constructorType: "admin",
      constructorAdmin: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    };

    writeDeployManifest(tmpDir, adminManifest);
    const read = readDeployManifest(tmpDir, "hello.aleo");
    expect(read?.constructorType).toBe("admin");
    expect(read?.constructorAdmin).toBe(
      "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    );
  });

  it("deployManifestPath returns correct path", () => {
    const result = deployManifestPath("/tmp/artifacts", "hello.aleo");
    expect(result).toBe("/tmp/artifacts/hello.aleo/deploy.json");
  });
});
