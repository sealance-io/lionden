/**
 * SDK adapter unit tests — validate that createSdkObjects and
 * createSignerSdkObjects wire Account, RecordProvider, and
 * ProgramManager correctly, including API-key propagation.
 *
 * These tests load the real @provablehq/sdk WASM module, so they
 * verify actual construction rather than mocked delegation.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  createSdkObjects,
  createSignerSdkObjects,
  decryptRecordCiphertext,
  deriveViewKey,
  NetworkRecordDecryptionError,
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
