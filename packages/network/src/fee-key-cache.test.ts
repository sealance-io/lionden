/**
 * Fee-key cache tests — warmup-on-init reads disk and populates the SDK's
 * cache; the write-back hook in PersistentFunctionKeyProvider serializes
 * proving keys to disk after the SDK fetches them.
 *
 * These tests mock the SDK module so they can drive the fingerprint and
 * filesystem-failure branches deterministically without a real WASM load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CREDITS_KEY_CACHE_FORMAT,
  fingerprintBytes,
  writeCreditsKeyCacheMetadata,
} from "@lionden/core";
import {
  PersistentFunctionKeyProvider,
  warmupFeeKeys,
} from "./sdk-adapter.js";

const WASM_HASH_A = "a".repeat(64);
const WASM_HASH_B = "b".repeat(64);
const NETWORK = "testnet" as const;

const FEE_PUBLIC_LOCATOR = "credits.aleo/fee_public:1";
const FEE_PRIVATE_LOCATOR = "credits.aleo/fee_private:1";

function encodeLocator(locator: string): string {
  return Buffer.from(locator, "utf-8").toString("base64url");
}

function feePaths(root: string, wasmHash: string, network: string, locator: string) {
  const dir = path.join(root, "lionden-credits", wasmHash, network);
  const safe = encodeLocator(locator);
  return {
    dir,
    prover: path.join(dir, `${safe}.prover`),
    metadata: path.join(dir, `${safe}.metadata.json`),
  };
}

function makeMockSdk() {
  const fromBytes = vi.fn((bytes: Uint8Array) => ({
    kind: "proving",
    toBytes: () => bytes,
  }));
  const verifyingKey = () => ({ kind: "verifying", toBytes: () => new Uint8Array([0xaa]) });
  return {
    sdk: {
      ProvingKey: { fromBytes },
      CREDITS_PROGRAM_KEYS: {
        fee_public: { locator: FEE_PUBLIC_LOCATOR, verifyingKey },
        fee_private: { locator: FEE_PRIVATE_LOCATOR, verifyingKey },
      },
    },
    fromBytes,
  };
}

function makeMockKeyProvider() {
  return {
    cacheKeys: vi.fn(),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-fee-keys-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("warmupFeeKeys", () => {
  it("does not call cacheKeys when no files exist on disk", async () => {
    const { sdk } = makeMockSdk();
    const kp = makeMockKeyProvider();
    await warmupFeeKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A);
    expect(kp.cacheKeys).not.toHaveBeenCalled();
  });

  it("calls cacheKeys with the SDK locator when prover + metadata are present and intact", async () => {
    const proverBytes = new Uint8Array([1, 2, 3, 4]);
    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.prover, proverBytes);
    writeCreditsKeyCacheMetadata(paths.metadata, {
      format: CREDITS_KEY_CACHE_FORMAT,
      locator: FEE_PUBLIC_LOCATOR,
      network: NETWORK,
      wasmHash: WASM_HASH_A,
      prover: fingerprintBytes(proverBytes),
    });

    const { sdk, fromBytes } = makeMockSdk();
    const kp = makeMockKeyProvider();
    await warmupFeeKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A);

    expect(fromBytes).toHaveBeenCalledOnce();
    expect(kp.cacheKeys).toHaveBeenCalledOnce();
    expect(kp.cacheKeys.mock.calls[0]![0]).toBe(FEE_PUBLIC_LOCATOR);
  });

  it("skips when prover bytes don't match the metadata fingerprint", async () => {
    const trueBytes = new Uint8Array([1, 2, 3]);
    const tamperedBytes = new Uint8Array([9, 9, 9]);
    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.prover, tamperedBytes);
    writeCreditsKeyCacheMetadata(paths.metadata, {
      format: CREDITS_KEY_CACHE_FORMAT,
      locator: FEE_PUBLIC_LOCATOR,
      network: NETWORK,
      wasmHash: WASM_HASH_A,
      prover: fingerprintBytes(trueBytes),
    });

    const { sdk } = makeMockSdk();
    const kp = makeMockKeyProvider();
    await warmupFeeKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A);

    expect(kp.cacheKeys).not.toHaveBeenCalled();
  });

  it("skips entries whose metadata wasmHash does not match the runtime", async () => {
    const proverBytes = new Uint8Array([1, 2, 3]);
    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.prover, proverBytes);
    writeCreditsKeyCacheMetadata(paths.metadata, {
      format: CREDITS_KEY_CACHE_FORMAT,
      locator: FEE_PUBLIC_LOCATOR,
      network: NETWORK,
      wasmHash: WASM_HASH_B, // mismatched
      prover: fingerprintBytes(proverBytes),
    });

    const { sdk } = makeMockSdk();
    const kp = makeMockKeyProvider();
    await warmupFeeKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A);

    expect(kp.cacheKeys).not.toHaveBeenCalled();
  });

  it("uses a different cache directory per wasmHash", async () => {
    const proverBytes = new Uint8Array([1, 2, 3]);
    const pathsA = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    fs.mkdirSync(pathsA.dir, { recursive: true });
    fs.writeFileSync(pathsA.prover, proverBytes);
    writeCreditsKeyCacheMetadata(pathsA.metadata, {
      format: CREDITS_KEY_CACHE_FORMAT,
      locator: FEE_PUBLIC_LOCATOR,
      network: NETWORK,
      wasmHash: WASM_HASH_A,
      prover: fingerprintBytes(proverBytes),
    });

    const { sdk } = makeMockSdk();
    const kp = makeMockKeyProvider();
    // Running with a different wasmHash looks at a different directory → cold cache.
    await warmupFeeKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_B);
    expect(kp.cacheKeys).not.toHaveBeenCalled();
  });

  it("never throws when individual entries fail; surfaces nothing to the caller", async () => {
    // Prepare a valid fee_public entry, but corrupt the metadata JSON for fee_private.
    const proverBytes = new Uint8Array([1, 2, 3]);
    const pubPaths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    const privPaths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PRIVATE_LOCATOR);
    fs.mkdirSync(pubPaths.dir, { recursive: true });
    fs.writeFileSync(pubPaths.prover, proverBytes);
    writeCreditsKeyCacheMetadata(pubPaths.metadata, {
      format: CREDITS_KEY_CACHE_FORMAT,
      locator: FEE_PUBLIC_LOCATOR,
      network: NETWORK,
      wasmHash: WASM_HASH_A,
      prover: fingerprintBytes(proverBytes),
    });
    fs.writeFileSync(privPaths.prover, proverBytes);
    fs.writeFileSync(privPaths.metadata, "{not json"); // malformed

    const { sdk } = makeMockSdk();
    const kp = makeMockKeyProvider();
    await expect(
      warmupFeeKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A),
    ).resolves.toBeUndefined();
    // The valid fee_public entry should still load.
    expect(kp.cacheKeys).toHaveBeenCalledOnce();
    expect(kp.cacheKeys.mock.calls[0]![0]).toBe(FEE_PUBLIC_LOCATOR);
  });
});

describe("PersistentFunctionKeyProvider write-back", () => {
  function makeDelegate() {
    const provingKey = { kind: "proving", toBytes: () => new Uint8Array([7, 7, 7]) };
    const verifyingKey = { kind: "verifying", toBytes: () => new Uint8Array([8]) };
    return {
      delegate: {
        bondPublicKeys: vi.fn(),
        bondValidatorKeys: vi.fn(),
        cacheKeys: vi.fn(),
        claimUnbondPublicKeys: vi.fn(),
        functionKeys: vi.fn(),
        feePrivateKeys: vi.fn().mockResolvedValue([provingKey, verifyingKey]),
        feePublicKeys: vi.fn().mockResolvedValue([provingKey, verifyingKey]),
        inclusionKeys: vi.fn(),
        joinKeys: vi.fn(),
        keyStore: vi.fn().mockResolvedValue(undefined),
        splitKeys: vi.fn(),
        transferKeys: vi.fn(),
        unBondPublicKeys: vi.fn(),
      },
      provingKey,
    };
  }

  function makePersistent() {
    const { sdk } = makeMockSdk();
    const { delegate, provingKey } = makeDelegate();
    const fileStore = { keys: vi.fn() } as any;
    const provider = new PersistentFunctionKeyProvider(delegate as any, fileStore, {
      sdk: sdk as any,
      cachePath: tmpDir,
      network: NETWORK,
      wasmHash: WASM_HASH_A,
    });
    return { provider, delegate, provingKey, sdk };
  }

  it("writes prover bytes + metadata after the first feePublicKeys() call", async () => {
    const { provider } = makePersistent();
    const result = await provider.feePublicKeys();
    expect(result).toBeDefined();

    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    expect(fs.existsSync(paths.prover)).toBe(true);
    expect(fs.existsSync(paths.metadata)).toBe(true);
    const bytes = fs.readFileSync(paths.prover);
    expect([...bytes]).toEqual([7, 7, 7]);
  });

  it("does not rewrite when the existing entry is complete and current (idempotent)", async () => {
    const { provider } = makePersistent();
    await provider.feePublicKeys();

    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    const firstStat = fs.statSync(paths.prover);

    // Second call: should not touch the file.
    await provider.feePublicKeys();
    const secondStat = fs.statSync(paths.prover);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  it("rewrites both files when metadata is missing (torn .prover-only entry)", async () => {
    const { provider } = makePersistent();
    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    // Simulate a process crash between writing prover and writing metadata.
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.prover, new Uint8Array([0, 0, 0]));
    expect(fs.existsSync(paths.metadata)).toBe(false);

    await provider.feePublicKeys();

    // Both files now present, prover replaced with the fresh fetched bytes
    // (7,7,7 from the mock delegate), metadata fingerprint matches.
    expect(fs.existsSync(paths.metadata)).toBe(true);
    expect([...fs.readFileSync(paths.prover)]).toEqual([7, 7, 7]);
    const metadata = JSON.parse(fs.readFileSync(paths.metadata, "utf-8"));
    expect(metadata.prover.sha256).toBe(
      fingerprintBytes(new Uint8Array([7, 7, 7])).sha256,
    );
  });

  it("rewrites both files when metadata is corrupt JSON", async () => {
    const { provider } = makePersistent();
    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.prover, new Uint8Array([0, 0, 0]));
    fs.writeFileSync(paths.metadata, "{not json");

    await provider.feePublicKeys();

    expect([...fs.readFileSync(paths.prover)]).toEqual([7, 7, 7]);
    const metadata = JSON.parse(fs.readFileSync(paths.metadata, "utf-8"));
    expect(metadata.prover.sha256).toBe(
      fingerprintBytes(new Uint8Array([7, 7, 7])).sha256,
    );
  });

  it("rewrites when .prover bytes are corrupt even though metadata is current", async () => {
    const { provider } = makePersistent();
    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    fs.mkdirSync(paths.dir, { recursive: true });
    // Metadata claims the fingerprint of the fetched key (7,7,7), but the
    // .prover bytes on disk are corrupted (0,0,0). Without the on-disk check
    // this slips past write-back and warmup will reject the entry next run.
    fs.writeFileSync(paths.prover, new Uint8Array([0, 0, 0]));
    writeCreditsKeyCacheMetadata(paths.metadata, {
      format: CREDITS_KEY_CACHE_FORMAT,
      locator: FEE_PUBLIC_LOCATOR,
      network: NETWORK,
      wasmHash: WASM_HASH_A,
      prover: fingerprintBytes(new Uint8Array([7, 7, 7])),
    });

    await provider.feePublicKeys();

    expect([...fs.readFileSync(paths.prover)]).toEqual([7, 7, 7]);
  });

  it("rewrites when on-disk fingerprint disagrees with the fetched key", async () => {
    const { provider } = makePersistent();
    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    fs.mkdirSync(paths.dir, { recursive: true });
    // Plant a stale prover + metadata pair that doesn't match what the delegate returns (7,7,7).
    fs.writeFileSync(paths.prover, new Uint8Array([0, 0, 0]));
    writeCreditsKeyCacheMetadata(paths.metadata, {
      format: CREDITS_KEY_CACHE_FORMAT,
      locator: FEE_PUBLIC_LOCATOR,
      network: NETWORK,
      wasmHash: WASM_HASH_A,
      prover: fingerprintBytes(new Uint8Array([0, 0, 0])),
    });

    await provider.feePublicKeys();

    expect([...fs.readFileSync(paths.prover)]).toEqual([7, 7, 7]);
    const metadata = JSON.parse(fs.readFileSync(paths.metadata, "utf-8"));
    expect(metadata.prover.sha256).toBe(
      fingerprintBytes(new Uint8Array([7, 7, 7])).sha256,
    );
  });

  it("uses a different file for feePrivate vs feePublic", async () => {
    const { provider } = makePersistent();
    await provider.feePublicKeys();
    await provider.feePrivateKeys();
    const pub = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    const priv = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PRIVATE_LOCATOR);
    expect(fs.existsSync(pub.prover)).toBe(true);
    expect(fs.existsSync(priv.prover)).toBe(true);
    expect(pub.prover).not.toBe(priv.prover);
  });

  it("returns the delegate keys even when filesystem writes throw", async () => {
    // Force a write failure by giving the provider a cachePath that lives
    // *inside* a regular file. mkdir under a file path fails with ENOTDIR on
    // every POSIX system.
    const blockingFile = path.join(tmpDir, "blocker.txt");
    fs.writeFileSync(blockingFile, "regular file, not a directory");
    const { sdk } = makeMockSdk();
    const { delegate } = makeDelegate();
    const provider = new PersistentFunctionKeyProvider(
      delegate as any,
      { keys: vi.fn() } as any,
      {
        sdk: sdk as any,
        cachePath: path.join(blockingFile, "nested"), // cannot be created
        network: NETWORK,
        wasmHash: WASM_HASH_A,
      },
    );
    const result = await provider.feePublicKeys();
    expect(delegate.feePublicKeys).toHaveBeenCalledOnce();
    expect(result).toBeDefined();
  });

  it("does not persist when feePersistence config is omitted", async () => {
    const { delegate } = makeDelegate();
    const provider = new PersistentFunctionKeyProvider(
      delegate as any,
      { keys: vi.fn() } as any,
    );
    await provider.feePublicKeys();
    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, FEE_PUBLIC_LOCATOR);
    expect(fs.existsSync(paths.prover)).toBe(false);
  });

  it("encodes the locator into a filesystem-safe filename", async () => {
    const { provider } = makePersistent();
    await provider.feePublicKeys();
    const dir = path.join(tmpDir, "lionden-credits", WASM_HASH_A, NETWORK);
    const entries = fs.readdirSync(dir);
    expect(entries.length).toBeGreaterThan(0);
    for (const name of entries) {
      // Filename must not contain raw locator separators.
      expect(name).not.toMatch(/[\/:]/);
    }
  });
});
