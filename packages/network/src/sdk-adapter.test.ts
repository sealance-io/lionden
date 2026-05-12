/**
 * SDK adapter unit tests — validate that createSdkObjects and
 * createSignerSdkObjects wire Account, RecordProvider, and
 * ProgramManager correctly, including API-key propagation.
 *
 * These tests load the real @provablehq/sdk WASM module, so they
 * verify actual construction rather than mocked delegation.
 */
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createSdkObjects,
  createSignerSdkObjects,
  PersistentFunctionKeyProvider,
  decryptRecordCiphertext,
  decryptValueCiphertext,
  deriveViewKey,
  NetworkRecordDecryptionError,
  NetworkValueDecryptionError,
  type SdkObjects,
} from "./sdk-adapter.js";

// Well-known devnode account-0
const DEVNODE_KEY =
  "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";
const DEVNODE_ADDR =
  "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";

// Well-known devnode account-1
const SIGNER_KEY =
  "APrivateKey1zkp2RWGDcde3efb89rjhME1VYA8QMxcxep5DShNBR6n8Yjh";
const SIGNER_ADDR =
  "aleo1s3ws5tra87fjycnjrwsjcrnw2qxr8jfqqdugnf0xzqqw29q9m5pqem2u4t";

let defaultSdk: SdkObjects;

// Create default SDK objects once — reused across tests
afterAll(() => {
  // Best-effort cleanup of WASM Account objects
  try { (defaultSdk?.account as any)?.destroy?.(); } catch { /* */ }
});

describe("createSdkObjects()", () => {
  it("creates SDK objects with the correct account address", async () => {
    defaultSdk = await createSdkObjects({
      network: "testnet",
      endpoint: "http://127.0.0.1:3030",
      privateKey: DEVNODE_KEY,
    });

    const addr = typeof (defaultSdk.account as any).address === "function"
      ? (defaultSdk.account as any).address().to_string()
      : String((defaultSdk.account as any).address);
    expect(addr).toBe(DEVNODE_ADDR);
  });

  it("passes API key to ProgramManager's internal network client", async () => {
    const sdk = await createSdkObjects({
      network: "testnet",
      endpoint: "http://127.0.0.1:3030",
      privateKey: DEVNODE_KEY,
      apiKey: "test-api-key",
    });

    // Verify the PM's internal network client received the API key header
    const pm = sdk.programManager as any;
    const ncHeaders = pm.networkClient?.headers ?? pm.networkClient?.account?.headers;
    expect(ncHeaders).toBeDefined();
    expect(ncHeaders["Authorization"]).toBe("Bearer test-api-key");
    try { (sdk.account as any)?.destroy?.(); } catch { /* */ }
  });

  it("wraps the SDK key provider once for filesystem key cache mode", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-sdk-keys-"));
    try {
      const sdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
        keyCache: { storage: "filesystem", path: path.join(tmpDir, ".aleo") },
      });

      expect(sdk.keyProvider).toBeInstanceOf(PersistentFunctionKeyProvider);
      expect((sdk.programManager as any).keyProvider).toBe(sdk.keyProvider);
      await expect(sdk.keyProvider.keyStore()).resolves.toBeDefined();

      try { (sdk.account as any)?.destroy?.(); } catch { /* */ }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("createSignerSdkObjects()", () => {
  it("creates an Account with the signer's private key, not the default", async () => {
    if (!defaultSdk) {
      defaultSdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
      });
    }

    const signerSdk = await createSignerSdkObjects({
      privateKey: SIGNER_KEY,
      endpoint: "http://127.0.0.1:3030",
      network: "testnet",
      keyProvider: defaultSdk.keyProvider,
    });

    const signerAddr = typeof (signerSdk.account as any).address === "function"
      ? (signerSdk.account as any).address().to_string()
      : String((signerSdk.account as any).address);
    expect(signerAddr).toBe(SIGNER_ADDR);

    // Verify it's not the default account
    const defaultAddr = typeof (defaultSdk.account as any).address === "function"
      ? (defaultSdk.account as any).address().to_string()
      : String((defaultSdk.account as any).address);
    expect(signerAddr).not.toBe(defaultAddr);

    try { (signerSdk.account as any)?.destroy?.(); } catch { /* */ }
  });

  it("wires the signer Account into ProgramManager", async () => {
    if (!defaultSdk) {
      defaultSdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
      });
    }

    const signerSdk = await createSignerSdkObjects({
      privateKey: SIGNER_KEY,
      endpoint: "http://127.0.0.1:3030",
      network: "testnet",
      keyProvider: defaultSdk.keyProvider,
    });

    // The PM's account must be the signer's, not the default
    const pm = signerSdk.programManager as any;
    const pmAddr = typeof pm.account?.address === "function"
      ? pm.account.address().to_string()
      : String(pm.account?.address);
    expect(pmAddr).toBe(SIGNER_ADDR);

    // The PM's recordProvider must be the same instance passed to it
    expect(pm.recordProvider).toBe(signerSdk.recordProvider);

    try { (signerSdk.account as any)?.destroy?.(); } catch { /* */ }
  });

  it("reuses the shared keyProvider from the default SDK objects", async () => {
    if (!defaultSdk) {
      defaultSdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
      });
    }

    const signerSdk = await createSignerSdkObjects({
      privateKey: SIGNER_KEY,
      endpoint: "http://127.0.0.1:3030",
      network: "testnet",
      keyProvider: defaultSdk.keyProvider,
    });

    // The PM's keyProvider must be the exact same instance as the default SDK's
    const pm = signerSdk.programManager as any;
    expect(pm.keyProvider).toBe(defaultSdk.keyProvider);

    try { (signerSdk.account as any)?.destroy?.(); } catch { /* */ }
  });

  it("reuses the persistent key provider for signer ProgramManagers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-sdk-keys-"));
    try {
      const sdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
        keyCache: { storage: "filesystem", path: path.join(tmpDir, ".aleo") },
      });
      const signerSdk = await createSignerSdkObjects({
        privateKey: SIGNER_KEY,
        endpoint: "http://127.0.0.1:3030",
        network: "testnet",
        keyProvider: sdk.keyProvider,
      });

      expect(sdk.keyProvider).toBeInstanceOf(PersistentFunctionKeyProvider);
      expect((signerSdk.programManager as any).keyProvider).toBe(sdk.keyProvider);

      try { (signerSdk.account as any)?.destroy?.(); } catch { /* */ }
      try { (sdk.account as any)?.destroy?.(); } catch { /* */ }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("deriveViewKey() / decryptRecordCiphertext()", () => {
  it("derives a deterministic view key from a known private key", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    expect(typeof vk).toBe("string");
    expect(vk.startsWith("AViewKey1")).toBe(true);
    // Determinism — same input must yield same output.
    expect(await deriveViewKey(DEVNODE_KEY)).toBe(vk);
  });

  it("throws NetworkRecordDecryptionError on non-private-key strings", async () => {
    await expect(deriveViewKey("not a key")).rejects.toBeInstanceOf(NetworkRecordDecryptionError);
    await expect(deriveViewKey("AViewKey1xyz")).rejects.toMatchObject({
      kind: "NetworkRecordDecryptionError",
      name: "NetworkRecordDecryptionError",
    });
  });

  it("throws NetworkRecordDecryptionError on empty ciphertext", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    await expect(decryptRecordCiphertext("", vk)).rejects.toMatchObject({
      kind: "NetworkRecordDecryptionError",
    });
  });

  it("throws NetworkRecordDecryptionError when view key doesn't have AViewKey1 prefix", async () => {
    await expect(
      decryptRecordCiphertext("record1abc", "APrivateKey1zkp..."),
    ).rejects.toMatchObject({
      kind: "NetworkRecordDecryptionError",
      message: expect.stringContaining("AViewKey1"),
    });
  });

  it("surfaces SDK errors as NetworkRecordDecryptionError with ciphertextPrefix", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    // Garbage ciphertext that passes the prefix check but the SDK rejects.
    await expect(
      decryptRecordCiphertext("record1garbagepayload", vk),
    ).rejects.toMatchObject({
      kind: "NetworkRecordDecryptionError",
      ciphertextPrefix: "record1garbagepa",
    });
  });
});

describe("decryptValueCiphertext()", () => {
  // Real devnode-captured tpk + ciphertext from
  // packages/network/src/__fixtures__/devnode-transition-tpk-sample.json.
  // compare_strategies(balance=10000) on governance.aleo — output[0] (linear,
  // global index = 1 input + abi index 0 = 1) should decrypt to "10000u64".
  const REAL_TPK = "3744613180382619741435840858040170311327807885111536643678978944748581058812group";
  const REAL_CT_LINEAR = "ciphertext1qyqzhjct2nh7a8ajexhyfr9pg3aehxpw5ulvypjleadlx07cpw0ggzgjt5uyj";
  const REAL_CT_QUADRATIC = "ciphertext1qyqgprwaxfulcpellukavaurqmzk24lrh3qcldjp6nhenq748gjvyyqvw9ek7";

  it("decrypts a real devnode value ciphertext to its plaintext Leo literal", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    const linear = await decryptValueCiphertext(
      REAL_CT_LINEAR, vk, REAL_TPK, "governance.aleo", "compare_strategies", 1,
    );
    expect(linear).toBe("10000u64");
    const quadratic = await decryptValueCiphertext(
      REAL_CT_QUADRATIC, vk, REAL_TPK, "governance.aleo", "compare_strategies", 2,
    );
    expect(quadratic).toBe("100u64");
  });

  it("throws NetworkValueDecryptionError on empty ciphertext", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    await expect(
      decryptValueCiphertext("", vk, REAL_TPK, "p.aleo", "t", 0),
    ).rejects.toMatchObject({ kind: "NetworkValueDecryptionError" });
  });

  it("throws NetworkValueDecryptionError when ciphertext lacks ciphertext1 prefix", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    await expect(
      decryptValueCiphertext("record1abc", vk, REAL_TPK, "p.aleo", "t", 0),
    ).rejects.toMatchObject({
      kind: "NetworkValueDecryptionError",
      message: expect.stringContaining("ciphertext1"),
    });
  });

  it("throws NetworkValueDecryptionError when view key doesn't have AViewKey1 prefix", async () => {
    await expect(
      decryptValueCiphertext(REAL_CT_LINEAR, "APrivateKey1zkp...", REAL_TPK, "p.aleo", "t", 0),
    ).rejects.toMatchObject({
      kind: "NetworkValueDecryptionError",
      message: expect.stringContaining("AViewKey1"),
    });
  });

  it("throws NetworkValueDecryptionError when tpk is empty", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    await expect(
      decryptValueCiphertext(REAL_CT_LINEAR, vk, "", "p.aleo", "t", 0),
    ).rejects.toMatchObject({
      kind: "NetworkValueDecryptionError",
      message: expect.stringContaining("tpk"),
    });
  });

  it("surfaces SDK errors with the ciphertextPrefix populated", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    // Wrong global index — SDK rejects.
    await expect(
      decryptValueCiphertext(REAL_CT_LINEAR, vk, REAL_TPK, "governance.aleo", "compare_strategies", 999),
    ).rejects.toMatchObject({
      kind: "NetworkValueDecryptionError",
      ciphertextPrefix: "ciphertext1qyqzh",
    });
  });

  it("is exported as a NetworkValueDecryptionError class", () => {
    const err = new NetworkValueDecryptionError("msg", "prefix");
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("NetworkValueDecryptionError");
    expect(err.ciphertextPrefix).toBe("prefix");
  });
});
