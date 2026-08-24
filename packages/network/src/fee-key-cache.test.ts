/**
 * Credits-key cache tests — warmup-on-init reads disk and populates the
 * SDK's cache; the write-back hooks in PersistentFunctionKeyProvider
 * serialize proving keys to disk after the SDK fetches them. Phase C
 * expanded coverage from fee_public/fee_private to every named entry of
 * CREDITS_PROGRAM_KEYS (inclusion, join, split, transfer_*, bond_*,
 * etc.); this file exercises the broader contract.
 *
 * These tests mock the SDK module so they can drive the fingerprint and
 * filesystem-failure branches deterministically without a real WASM load.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CREDITS_KEY_CACHE_FORMAT,
  fingerprintBytes,
  writeCreditsKeyCacheMetadata,
} from "@lionden/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistentFunctionKeyProvider, warmupCreditsKeys } from "./sdk-adapter.js";

const WASM_HASH_A = "a".repeat(64);
const WASM_HASH_B = "b".repeat(64);
const NETWORK = "testnet" as const;

const FEE_PUBLIC_LOCATOR = "credits.aleo/fee_public:1";
const FEE_PRIVATE_LOCATOR = "credits.aleo/fee_private:1";
const INCLUSION_LOCATOR = "credits.aleo/inclusion:1";
const JOIN_LOCATOR = "credits.aleo/join:1";
const SPLIT_LOCATOR = "credits.aleo/split:1";
const BOND_PUBLIC_LOCATOR = "credits.aleo/bond_public:1";
const BOND_VALIDATOR_LOCATOR = "credits.aleo/bond_validator:1";
const CLAIM_UNBOND_PUBLIC_LOCATOR = "credits.aleo/claim_unbond_public:1";
const UNBOND_PUBLIC_LOCATOR = "credits.aleo/unbond_public:1";
const SET_VALIDATOR_STATE_LOCATOR = "credits.aleo/set_validator_state:1";
const TRANSFER_PUBLIC_LOCATOR = "credits.aleo/transfer_public:1";
const TRANSFER_PRIVATE_LOCATOR = "credits.aleo/transfer_private:1";
const TRANSFER_PUBLIC_TO_PRIVATE_LOCATOR = "credits.aleo/transfer_public_to_private:1";
const TRANSFER_PRIVATE_TO_PUBLIC_LOCATOR = "credits.aleo/transfer_private_to_public:1";
const TRANSFER_PUBLIC_AS_SIGNER_LOCATOR = "credits.aleo/transfer_public_as_signer:1";

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
  const entry = (locator: string) => ({
    locator,
    prover: `https://parameters.example/${locator}.prover`,
    verifier: `https://parameters.example/${locator}.verifier`,
    verifyingKey,
  });
  return {
    sdk: {
      ProvingKey: { fromBytes },
      CREDITS_PROGRAM_KEYS: {
        fee_public: entry(FEE_PUBLIC_LOCATOR),
        fee_private: entry(FEE_PRIVATE_LOCATOR),
        inclusion: entry(INCLUSION_LOCATOR),
        join: entry(JOIN_LOCATOR),
        split: entry(SPLIT_LOCATOR),
        bond_public: entry(BOND_PUBLIC_LOCATOR),
        bond_validator: entry(BOND_VALIDATOR_LOCATOR),
        claim_unbond_public: entry(CLAIM_UNBOND_PUBLIC_LOCATOR),
        unbond_public: entry(UNBOND_PUBLIC_LOCATOR),
        set_validator_state: entry(SET_VALIDATOR_STATE_LOCATOR),
        transfer_public: entry(TRANSFER_PUBLIC_LOCATOR),
        transfer_private: entry(TRANSFER_PRIVATE_LOCATOR),
        transfer_public_to_private: entry(TRANSFER_PUBLIC_TO_PRIVATE_LOCATOR),
        transfer_private_to_public: entry(TRANSFER_PRIVATE_TO_PUBLIC_LOCATOR),
        transfer_public_as_signer: entry(TRANSFER_PUBLIC_AS_SIGNER_LOCATOR),
        // Helper-style entries that are NOT a warmable key. Mirrors the
        // real SDK's `getKey` accessor — warmupCreditsKeys must skip these.
        getKey: function (k: string) {
          return (this as any)[k];
        },
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

describe("warmupCreditsKeys", () => {
  it("does not call cacheKeys when no files exist on disk", async () => {
    const { sdk } = makeMockSdk();
    const kp = makeMockKeyProvider();
    await warmupCreditsKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A);
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
    await warmupCreditsKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A);

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
    await warmupCreditsKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A);

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
    await warmupCreditsKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A);

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
    await warmupCreditsKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_B);
    expect(kp.cacheKeys).not.toHaveBeenCalled();
  });

  it("warms every named credits entry that has a complete on-disk cache, not only fee_*", async () => {
    // Plant on-disk entries for inclusion, join, split, and one transfer
    // variant — the Phase C scope is the full CREDITS_PROGRAM_KEYS map,
    // so warmup must hit every one of these locators, not stop at fees.
    const proverBytes = new Uint8Array([1, 2, 3]);
    const locators = [INCLUSION_LOCATOR, JOIN_LOCATOR, SPLIT_LOCATOR, TRANSFER_PUBLIC_LOCATOR];
    for (const locator of locators) {
      const p = feePaths(tmpDir, WASM_HASH_A, NETWORK, locator);
      fs.mkdirSync(p.dir, { recursive: true });
      fs.writeFileSync(p.prover, proverBytes);
      writeCreditsKeyCacheMetadata(p.metadata, {
        format: CREDITS_KEY_CACHE_FORMAT,
        locator,
        network: NETWORK,
        wasmHash: WASM_HASH_A,
        prover: fingerprintBytes(proverBytes),
      });
    }

    const { sdk } = makeMockSdk();
    const kp = makeMockKeyProvider();
    await warmupCreditsKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A);

    expect(kp.cacheKeys).toHaveBeenCalledTimes(locators.length);
    const cachedLocators = kp.cacheKeys.mock.calls.map((c) => c[0]).sort();
    expect(cachedLocators).toEqual([...locators].sort());
  });

  it("ignores non-entry keys on CREDITS_PROGRAM_KEYS (e.g. the `getKey` helper)", async () => {
    // The real SDK exposes `getKey` as a function on CREDITS_PROGRAM_KEYS.
    // warmupCreditsKeys must filter to entries that look like a credits
    // key (locator string + verifyingKey function) and not crash on the
    // helper.
    const { sdk } = makeMockSdk();
    const kp = makeMockKeyProvider();
    await expect(
      warmupCreditsKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A),
    ).resolves.toBeUndefined();
    expect(kp.cacheKeys).not.toHaveBeenCalled(); // no on-disk entries yet
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
      warmupCreditsKeys(kp as any, sdk as any, tmpDir, NETWORK, WASM_HASH_A),
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
    const pair = [provingKey, verifyingKey];
    return {
      delegate: {
        bondPublicKeys: vi.fn().mockResolvedValue(pair),
        bondValidatorKeys: vi.fn().mockResolvedValue(pair),
        cacheKeys: vi.fn(),
        claimUnbondPublicKeys: vi.fn().mockResolvedValue(pair),
        functionKeys: vi.fn().mockResolvedValue(pair),
        feePrivateKeys: vi.fn().mockResolvedValue(pair),
        feePublicKeys: vi.fn().mockResolvedValue(pair),
        inclusionKeys: vi.fn().mockResolvedValue(pair),
        joinKeys: vi.fn().mockResolvedValue(pair),
        keyStore: vi.fn().mockResolvedValue(undefined),
        splitKeys: vi.fn().mockResolvedValue(pair),
        transferKeys: vi.fn().mockResolvedValue(pair),
        unBondPublicKeys: vi.fn().mockResolvedValue(pair),
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
    expect(metadata.prover.sha256).toBe(fingerprintBytes(new Uint8Array([7, 7, 7])).sha256);
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
    expect(metadata.prover.sha256).toBe(fingerprintBytes(new Uint8Array([7, 7, 7])).sha256);
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
    expect(metadata.prover.sha256).toBe(fingerprintBytes(new Uint8Array([7, 7, 7])).sha256);
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
    const provider = new PersistentFunctionKeyProvider(delegate as any, { keys: vi.fn() } as any, {
      sdk: sdk as any,
      cachePath: path.join(blockingFile, "nested"), // cannot be created
      network: NETWORK,
      wasmHash: WASM_HASH_A,
    });
    const result = await provider.feePublicKeys();
    expect(delegate.feePublicKeys).toHaveBeenCalledOnce();
    expect(result).toBeDefined();
  });

  it("does not persist when creditsPersistence config is omitted", async () => {
    const { delegate } = makeDelegate();
    const provider = new PersistentFunctionKeyProvider(delegate as any, { keys: vi.fn() } as any);
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
      expect(name).not.toMatch(/[/:]/);
    }
  });

  // -------------------------------------------------------------------------
  // Phase C — write-back must cover every credits.aleo key the SDK can
  // request, not just fee_public / fee_private. These tests lock in the
  // expanded contract so a regression that drops a delegate wrapper is
  // caught immediately.
  // -------------------------------------------------------------------------
  it.each([
    ["inclusionKeys", INCLUSION_LOCATOR],
    ["joinKeys", JOIN_LOCATOR],
    ["splitKeys", SPLIT_LOCATOR],
    ["bondPublicKeys", BOND_PUBLIC_LOCATOR],
    ["bondValidatorKeys", BOND_VALIDATOR_LOCATOR],
    ["claimUnbondPublicKeys", CLAIM_UNBOND_PUBLIC_LOCATOR],
    ["unBondPublicKeys", UNBOND_PUBLIC_LOCATOR],
  ] as const)("writes the on-disk entry after %s() is called", async (method, locator) => {
    const { provider } = makePersistent();
    await (provider as any)[method]();

    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, locator);
    expect(fs.existsSync(paths.prover)).toBe(true);
    expect(fs.existsSync(paths.metadata)).toBe(true);
    expect([...fs.readFileSync(paths.prover)]).toEqual([7, 7, 7]);
  });

  it.each([
    ["private", TRANSFER_PRIVATE_LOCATOR],
    ["transfer_private", TRANSFER_PRIVATE_LOCATOR],
    ["transferPrivate", TRANSFER_PRIVATE_LOCATOR],
    ["public", TRANSFER_PUBLIC_LOCATOR],
    ["transfer_public", TRANSFER_PUBLIC_LOCATOR],
    ["transferPublic", TRANSFER_PUBLIC_LOCATOR],
    ["public_as_signer", TRANSFER_PUBLIC_AS_SIGNER_LOCATOR],
    ["transferPublicAsSigner", TRANSFER_PUBLIC_AS_SIGNER_LOCATOR],
    ["private_to_public", TRANSFER_PRIVATE_TO_PUBLIC_LOCATOR],
    ["transferPrivateToPublic", TRANSFER_PRIVATE_TO_PUBLIC_LOCATOR],
    ["public_to_private", TRANSFER_PUBLIC_TO_PRIVATE_LOCATOR],
    ["transferPublicToPrivate", TRANSFER_PUBLIC_TO_PRIVATE_LOCATOR],
  ] as const)(
    "maps transferKeys(%s) to the correct credits entry and writes it back",
    async (visibility, locator) => {
      const { provider } = makePersistent();
      await provider.transferKeys(visibility);

      const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, locator);
      expect(fs.existsSync(paths.prover)).toBe(true);
      expect(fs.existsSync(paths.metadata)).toBe(true);
    },
  );

  it("skips persistence for transferKeys with an unknown visibility but still returns the delegate result", async () => {
    const { provider, delegate } = makePersistent();
    const result = await provider.transferKeys("nonsense-visibility");
    expect(result).toBeDefined();
    expect(delegate.transferKeys).toHaveBeenCalledOnce();

    // No file should be on disk for an unmapped visibility.
    const dir = path.join(tmpDir, "lionden-credits", WASM_HASH_A, NETWORK);
    if (fs.existsSync(dir)) {
      expect(fs.readdirSync(dir)).toEqual([]);
    }
  });

  it("persists set_validator_state when functionKeys is called with the credits cacheKey", async () => {
    const { provider } = makePersistent();
    await provider.functionKeys({
      proverUri: `https://parameters.example/${SET_VALIDATOR_STATE_LOCATOR}.prover`,
      verifierUri: `https://parameters.example/${SET_VALIDATOR_STATE_LOCATOR}.verifier`,
      cacheKey: "credits.aleo/set_validator_state",
    });

    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, SET_VALIDATOR_STATE_LOCATOR);
    expect(fs.existsSync(paths.prover)).toBe(true);
    expect(fs.existsSync(paths.metadata)).toBe(true);
  });

  it("persists credits entries identified by functionKeys({ name })", async () => {
    const { provider } = makePersistent();
    await provider.functionKeys({ name: "set_validator_state" });

    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, SET_VALIDATOR_STATE_LOCATOR);
    expect(fs.existsSync(paths.prover)).toBe(true);
  });

  it("persists credits entries identified by functionKeys proverUri/verifierUri (no cacheKey)", async () => {
    const { provider } = makePersistent();
    await provider.functionKeys({
      proverUri: `https://parameters.example/${SET_VALIDATOR_STATE_LOCATOR}.prover`,
      verifierUri: `https://parameters.example/${SET_VALIDATOR_STATE_LOCATOR}.verifier`,
    });

    const paths = feePaths(tmpDir, WASM_HASH_A, NETWORK, SET_VALIDATOR_STATE_LOCATOR);
    expect(fs.existsSync(paths.prover)).toBe(true);
  });

  it("does not persist for functionKeys with arbitrary (non-credits) locators", async () => {
    const { provider, delegate } = makePersistent();
    await provider.functionKeys({
      proverUri: "https://example.invalid/user/myProgram.aleo/myFn.prover",
      verifierUri: "https://example.invalid/user/myProgram.aleo/myFn.verifier",
      cacheKey: "myProgram.aleo/myFn",
    });
    expect(delegate.functionKeys).toHaveBeenCalledOnce();

    // No credits locator identified — disk should stay empty.
    const dir = path.join(tmpDir, "lionden-credits", WASM_HASH_A, NETWORK);
    if (fs.existsSync(dir)) {
      expect(fs.readdirSync(dir)).toEqual([]);
    }
  });

  it("does not persist for functionKeys with an unknown name", async () => {
    const { provider, delegate } = makePersistent();
    await provider.functionKeys({ name: "anything" });
    expect(delegate.functionKeys).toHaveBeenCalledOnce();

    const dir = path.join(tmpDir, "lionden-credits", WASM_HASH_A, NETWORK);
    if (fs.existsSync(dir)) {
      expect(fs.readdirSync(dir)).toEqual([]);
    }
  });
});
