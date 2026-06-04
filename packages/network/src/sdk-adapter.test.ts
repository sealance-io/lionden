/**
 * SDK adapter unit tests — validate that createSdkObjects and
 * createSignerSdkObjects wire Account, RecordProvider, and
 * ProgramManager correctly, including API-key propagation.
 *
 * These tests load the real @provablehq/sdk WASM module, so they
 * verify actual construction rather than mocked delegation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  applySdkLogLevel,
  createSdkObjects,
  createSignerSdkObjects,
  decryptRecordCiphertext,
  decryptValueCiphertext,
  deriveViewKey,
  NetworkRecordDecryptionError,
  NetworkValueDecryptionError,
  PersistentFunctionKeyProvider,
  programAddressFromProgramId,
  type SdkEgressPolicy,
  type SdkObjects,
  synthesizeExecutionKeyBytes,
} from "./sdk-adapter.js";

const TEST_EGRESS_POLICY: SdkEgressPolicy = {
  allowedNetworkHosts: new Set(["127.0.0.1:3030"]),
  violation: "block",
};

// Well-known devnode account-0
const DEVNODE_KEY = "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";
const DEVNODE_ADDR = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";

// Well-known devnode account-1
const SIGNER_KEY = "APrivateKey1zkp2RWGDcde3efb89rjhME1VYA8QMxcxep5DShNBR6n8Yjh";
const SIGNER_ADDR = "aleo1s3ws5tra87fjycnjrwsjcrnw2qxr8jfqqdugnf0xzqqw29q9m5pqem2u4t";

let defaultSdk: SdkObjects;

// Create default SDK objects once — reused across tests
afterAll(() => {
  // Best-effort cleanup of WASM Account objects
  try {
    (defaultSdk?.account as any)?.destroy?.();
  } catch {
    /* */
  }
});

describe("programAddressFromProgramId()", () => {
  it("derives deterministic program addresses with the SDK", () => {
    expect(programAddressFromProgramId("compliant_amm.aleo")).toBe(
      "aleo1xf5fmhacujf7jvyzynr24388hk82x606lgr62fkah054g5yz4ygsauf0wk",
    );
  });

  it("returns a stable, memoized address across repeated calls", () => {
    const first = programAddressFromProgramId("compliant_amm.aleo");
    const second = programAddressFromProgramId("compliant_amm.aleo");
    expect(second).toBe(first);
    // Distinct program ids must not collide in the cache.
    expect(programAddressFromProgramId("token.aleo")).not.toBe(first);
  });
});

describe("applySdkLogLevel()", () => {
  it("calls SDK setLogLevel when the import exposes it", () => {
    const setLogLevel = vi.fn();

    applySdkLogLevel({ setLogLevel } as any, "debug");

    expect(setLogLevel).toHaveBeenCalledWith("debug");
  });

  it("ignores older SDK imports without setLogLevel", () => {
    expect(() => applySdkLogLevel({} as any, "silent")).not.toThrow();
  });
});

describe("createSdkObjects()", () => {
  it("creates SDK objects with the correct account address", async () => {
    defaultSdk = await createSdkObjects({
      network: "testnet",
      endpoint: "http://127.0.0.1:3030",
      privateKey: DEVNODE_KEY,
      egressPolicy: TEST_EGRESS_POLICY,
    });

    const addr =
      typeof (defaultSdk.account as any).address === "function"
        ? (defaultSdk.account as any).address().to_string()
        : String((defaultSdk.account as any).address);
    expect(addr).toBe(DEVNODE_ADDR);
    expect(typeof defaultSdk.programManagerBase.synthesizeKeyPair).toBe("function");
  });

  it("passes API key to ProgramManager's internal network client", async () => {
    const sdk = await createSdkObjects({
      network: "testnet",
      endpoint: "http://127.0.0.1:3030",
      privateKey: DEVNODE_KEY,
      apiKey: "test-api-key",
      egressPolicy: TEST_EGRESS_POLICY,
    });

    // Verify the PM's internal network client received the API key header
    const pm = sdk.programManager as any;
    const ncHeaders = pm.networkClient?.headers ?? pm.networkClient?.account?.headers;
    expect(ncHeaders).toBeDefined();
    expect(ncHeaders["Authorization"]).toBe("Bearer test-api-key");
    try {
      (sdk.account as any)?.destroy?.();
    } catch {
      /* */
    }
  });

  it("flips hasCustomTransport on the standalone and PM-internal network clients when an egress policy is set", async () => {
    const sdk = await createSdkObjects({
      network: "testnet",
      endpoint: "http://127.0.0.1:3030",
      privateKey: DEVNODE_KEY,
      egressPolicy: TEST_EGRESS_POLICY,
    });

    // Standalone networkClient — used by getMappingValue/getProgram/etc.
    expect((sdk.networkClient as any).hasCustomTransport).toBe(true);
    // ProgramManager's *internal* networkClient — this is the one the
    // prove path reads at browser.js:5796 to decide whether to use
    // CallbackQuery vs WASM's internal SnapshotQuery. The leak we're
    // closing requires both to carry the transport.
    expect((sdk.programManager as any).networkClient.hasCustomTransport).toBe(true);

    try {
      (sdk.account as any)?.destroy?.();
    } catch {
      /* */
    }
  });

  it("installs the parameter transport on AleoKeyProvider with the internal known-host allowlist", async () => {
    const sdk = await createSdkObjects({
      network: "testnet",
      endpoint: "http://127.0.0.1:3030",
      privateKey: DEVNODE_KEY,
      egressPolicy: TEST_EGRESS_POLICY,
    });

    // Without keyCache, keyProvider is the raw AleoKeyProvider — its
    // `transport` field is the guarded transport we built (a function
    // distinct from defaultTransport).
    const transport = (sdk.keyProvider as any).transport;
    expect(typeof transport).toBe("function");
    expect(transport.length).toBeGreaterThanOrEqual(0); // typeof fetch

    // Unknown host must be rejected with the stale-allowlist wording —
    // and never call fetch.
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      await expect(transport("https://blocked.example/x")).rejects.toThrow(
        /LionDen does not recognize SDK parameter host "blocked\.example"/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();

      // A known parameter host is forwarded (fetch stubbed so no real call).
      const res = await transport("https://parameters.provable.com/testnet/fee_public.prover");
      expect(res.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }

    try {
      (sdk.account as any)?.destroy?.();
    } catch {
      /* */
    }
  });

  it("rejects empty or invalid endpoints fast (defensive guard)", async () => {
    await expect(
      createSdkObjects({
        network: "testnet",
        endpoint: "",
        privateKey: DEVNODE_KEY,
        egressPolicy: TEST_EGRESS_POLICY,
      }),
    ).rejects.toThrow(/non-empty endpoint string/);
    await expect(
      createSdkObjects({
        network: "testnet",
        endpoint: "not a url",
        privateKey: DEVNODE_KEY,
        egressPolicy: TEST_EGRESS_POLICY,
      }),
    ).rejects.toThrow(/invalid endpoint URL/);
  });

  it("wraps the SDK key provider once for filesystem key cache mode", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-sdk-keys-"));
    try {
      const sdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
        keyCache: { storage: "filesystem", path: path.join(tmpDir, ".aleo") },
        egressPolicy: TEST_EGRESS_POLICY,
      });

      expect(sdk.keyProvider).toBeInstanceOf(PersistentFunctionKeyProvider);
      expect((sdk.programManager as any).keyProvider).toBe(sdk.keyProvider);
      await expect(sdk.keyProvider.keyStore()).resolves.toBeDefined();

      try {
        (sdk.account as any)?.destroy?.();
      } catch {
        /* */
      }
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
        egressPolicy: TEST_EGRESS_POLICY,
      });
    }

    const signerSdk = await createSignerSdkObjects({
      privateKey: SIGNER_KEY,
      endpoint: "http://127.0.0.1:3030",
      network: "testnet",
      keyProvider: defaultSdk.keyProvider,
      egressPolicy: TEST_EGRESS_POLICY,
    });

    const signerAddr =
      typeof (signerSdk.account as any).address === "function"
        ? (signerSdk.account as any).address().to_string()
        : String((signerSdk.account as any).address);
    expect(signerAddr).toBe(SIGNER_ADDR);
    expect(typeof signerSdk.programManagerBase.synthesizeKeyPair).toBe("function");

    // Verify it's not the default account
    const defaultAddr =
      typeof (defaultSdk.account as any).address === "function"
        ? (defaultSdk.account as any).address().to_string()
        : String((defaultSdk.account as any).address);
    expect(signerAddr).not.toBe(defaultAddr);

    try {
      (signerSdk.account as any)?.destroy?.();
    } catch {
      /* */
    }
  });

  it("wires the signer Account into ProgramManager", async () => {
    if (!defaultSdk) {
      defaultSdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
        egressPolicy: TEST_EGRESS_POLICY,
      });
    }

    const signerSdk = await createSignerSdkObjects({
      privateKey: SIGNER_KEY,
      endpoint: "http://127.0.0.1:3030",
      network: "testnet",
      keyProvider: defaultSdk.keyProvider,
      egressPolicy: TEST_EGRESS_POLICY,
    });

    // The PM's account must be the signer's, not the default
    const pm = signerSdk.programManager as any;
    const pmAddr =
      typeof pm.account?.address === "function"
        ? pm.account.address().to_string()
        : String(pm.account?.address);
    expect(pmAddr).toBe(SIGNER_ADDR);

    // The PM's recordProvider must be the same instance passed to it
    expect(pm.recordProvider).toBe(signerSdk.recordProvider);

    try {
      (signerSdk.account as any)?.destroy?.();
    } catch {
      /* */
    }
  });

  it("reuses the shared keyProvider from the default SDK objects", async () => {
    if (!defaultSdk) {
      defaultSdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
        egressPolicy: TEST_EGRESS_POLICY,
      });
    }

    const signerSdk = await createSignerSdkObjects({
      privateKey: SIGNER_KEY,
      endpoint: "http://127.0.0.1:3030",
      network: "testnet",
      keyProvider: defaultSdk.keyProvider,
      egressPolicy: TEST_EGRESS_POLICY,
    });

    // The PM's keyProvider must be the exact same instance as the default SDK's
    const pm = signerSdk.programManager as any;
    expect(pm.keyProvider).toBe(defaultSdk.keyProvider);

    try {
      (signerSdk.account as any)?.destroy?.();
    } catch {
      /* */
    }
  });

  it("propagates hasCustomTransport to the signer's standalone and PM-internal network clients", async () => {
    if (!defaultSdk) {
      defaultSdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
        egressPolicy: TEST_EGRESS_POLICY,
      });
    }

    const signerSdk = await createSignerSdkObjects({
      privateKey: SIGNER_KEY,
      endpoint: "http://127.0.0.1:3030",
      network: "testnet",
      keyProvider: defaultSdk.keyProvider,
      egressPolicy: TEST_EGRESS_POLICY,
    });

    // The per-signer prove path uses the per-signer PM's internal
    // network client. Both layers must carry the transport for
    // CallbackQuery routing to kick in: the standalone one wrapped by
    // the RecordProvider AND the one ProgramManager built internally.
    const pm = signerSdk.programManager as any;
    expect(pm.networkClient.hasCustomTransport).toBe(true);
    expect((signerSdk.recordProvider as any).networkClient.hasCustomTransport).toBe(true);

    try {
      (signerSdk.account as any)?.destroy?.();
    } catch {
      /* */
    }
  });

  it("rejects empty or invalid endpoints fast in the signer factory too", async () => {
    if (!defaultSdk) {
      defaultSdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
        egressPolicy: TEST_EGRESS_POLICY,
      });
    }
    await expect(
      createSignerSdkObjects({
        privateKey: SIGNER_KEY,
        endpoint: "",
        network: "testnet",
        keyProvider: defaultSdk.keyProvider,
        egressPolicy: TEST_EGRESS_POLICY,
      }),
    ).rejects.toThrow(/non-empty endpoint string/);
  });

  it("reuses the persistent key provider for signer ProgramManagers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-sdk-keys-"));
    try {
      const sdk = await createSdkObjects({
        network: "testnet",
        endpoint: "http://127.0.0.1:3030",
        privateKey: DEVNODE_KEY,
        keyCache: { storage: "filesystem", path: path.join(tmpDir, ".aleo") },
        egressPolicy: TEST_EGRESS_POLICY,
      });
      const signerSdk = await createSignerSdkObjects({
        privateKey: SIGNER_KEY,
        endpoint: "http://127.0.0.1:3030",
        network: "testnet",
        keyProvider: sdk.keyProvider,
        egressPolicy: TEST_EGRESS_POLICY,
      });

      expect(sdk.keyProvider).toBeInstanceOf(PersistentFunctionKeyProvider);
      expect((signerSdk.programManager as any).keyProvider).toBe(sdk.keyProvider);

      try {
        (signerSdk.account as any)?.destroy?.();
      } catch {
        /* */
      }
      try {
        (sdk.account as any)?.destroy?.();
      } catch {
        /* */
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("synthesizeExecutionKeyBytes()", () => {
  it("passes prepared inputs, imports, explicit private key, and edition to ProgramManagerBase", async () => {
    const privateKey = { kind: "private-key" };
    const keyPair = {
      provingKey: vi.fn(() => ({ toBytes: () => new Uint8Array([1, 2]) })),
      verifyingKey: vi.fn(() => ({ toBytes: () => new Uint8Array([3, 4]) })),
    };
    const programManagerBase = {
      synthesizeKeyPair: vi.fn().mockResolvedValue(keyPair),
    };
    const imports = { "dep.aleo": "program dep.aleo;" };

    const result = await synthesizeExecutionKeyBytes({
      programManagerBase: programManagerBase as any,
      privateKey: privateKey as any,
      source: "import dep.aleo;\nprogram app.aleo;",
      transitionName: "main",
      inputs: ["prepared"],
      imports,
      edition: 7,
    });

    expect(programManagerBase.synthesizeKeyPair).toHaveBeenCalledWith(
      privateKey,
      "import dep.aleo;\nprogram app.aleo;",
      "main",
      ["prepared"],
      imports,
      7,
    );
    expect(keyPair.provingKey).toHaveBeenCalledOnce();
    expect(keyPair.verifyingKey).toHaveBeenCalledOnce();
    expect([...result.provingKeyBytes]).toEqual([1, 2]);
    expect([...result.verifyingKeyBytes]).toEqual([3, 4]);
  });

  it("leaves imports and edition undefined when they are unknown", async () => {
    const privateKey = { kind: "private-key" };
    const keyPair = {
      provingKey: vi.fn(() => ({ toBytes: () => new Uint8Array([1]) })),
      verifyingKey: vi.fn(() => ({ toBytes: () => new Uint8Array([2]) })),
    };
    const programManagerBase = {
      synthesizeKeyPair: vi.fn().mockResolvedValue(keyPair),
    };

    await synthesizeExecutionKeyBytes({
      programManagerBase: programManagerBase as any,
      privateKey: privateKey as any,
      source: "program hello.aleo;",
      transitionName: "main",
      inputs: ["prepared"],
    });

    expect(programManagerBase.synthesizeKeyPair).toHaveBeenCalledWith(
      privateKey,
      "program hello.aleo;",
      "main",
      ["prepared"],
      undefined,
      undefined,
    );
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
    await expect(decryptRecordCiphertext("record1abc", "APrivateKey1zkp...")).rejects.toMatchObject(
      {
        kind: "NetworkRecordDecryptionError",
        message: expect.stringContaining("AViewKey1"),
      },
    );
  });

  it("surfaces SDK errors as NetworkRecordDecryptionError with ciphertextPrefix", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    // Garbage ciphertext that passes the prefix check but the SDK rejects.
    await expect(decryptRecordCiphertext("record1garbagepayload", vk)).rejects.toMatchObject({
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
  const REAL_TPK =
    "3744613180382619741435840858040170311327807885111536643678978944748581058812group";
  const REAL_CT_LINEAR = "ciphertext1qyqzhjct2nh7a8ajexhyfr9pg3aehxpw5ulvypjleadlx07cpw0ggzgjt5uyj";
  const REAL_CT_QUADRATIC =
    "ciphertext1qyqgprwaxfulcpellukavaurqmzk24lrh3qcldjp6nhenq748gjvyyqvw9ek7";

  it("decrypts a real devnode value ciphertext to its plaintext Leo literal", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    const linear = await decryptValueCiphertext(
      REAL_CT_LINEAR,
      vk,
      REAL_TPK,
      "governance.aleo",
      "compare_strategies",
      1,
    );
    expect(linear).toBe("10000u64");
    const quadratic = await decryptValueCiphertext(
      REAL_CT_QUADRATIC,
      vk,
      REAL_TPK,
      "governance.aleo",
      "compare_strategies",
      2,
    );
    expect(quadratic).toBe("100u64");
  });

  it("throws NetworkValueDecryptionError on empty ciphertext", async () => {
    const vk = await deriveViewKey(DEVNODE_KEY);
    await expect(decryptValueCiphertext("", vk, REAL_TPK, "p.aleo", "t", 0)).rejects.toMatchObject({
      kind: "NetworkValueDecryptionError",
    });
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
      decryptValueCiphertext(
        REAL_CT_LINEAR,
        vk,
        REAL_TPK,
        "governance.aleo",
        "compare_strategies",
        999,
      ),
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
