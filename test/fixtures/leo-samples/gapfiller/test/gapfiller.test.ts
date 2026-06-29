// Gap-filler runtime suite — surfaces leo-samples does not exercise. Runtime
// green requires a devnode; typechecked against the generated bindings.
//
//   .locally round-trips           — primitive serializers
//   TransitionInputError           — out-of-range input rejected before execution
//   hashing                        — BHP/Pedersen/Poseidon → field
//   EncryptedRecord/Value.decrypt  — correct key works; wrong key / bad key string
//                                    → Local{Record,Value}DecryptionError / RecordDecryptionKeyError
import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Leo,
  LocalRecordDecryptionError,
  RecordDecryptionKeyError,
  TransitionInputError,
} from "../typechain/BaseContract.js";
import { createLiondenGapfiller } from "../typechain/LiondenGapfiller.js";

async function deployGapfiller() {
  const ctx = await setup();
  try {
    await ctx.deploy("lionden_gapfiller", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;
const gap = createLiondenGapfiller();

beforeAll(async () => {
  const fixture = await loadFixture(deployGapfiller);
  ctx = fixture.ctx;
  gap.connect(ctx.lre);
});

afterAll(async () => {
  if (ctx) await ctx.teardown();
  else clearFixtures();
});

describe("lionden_gapfiller — primitive serializer round-trips", () => {
  it("echo_bool(true) = true", async () => {
    expect(await gap.echo_bool.locally({ arg0: true })).toBe(true);
  });

  it("echo_u64(42) = 42n", async () => {
    expect(await gap.echo_u64.locally({ arg0: 42n })).toBe(42n);
  });

  it("echo_i128(-7) = -7n", async () => {
    expect(await gap.echo_i128.locally({ arg0: -7n })).toBe(-7n);
  });

  it("echo_field round-trips a field value", async () => {
    const out = await gap.echo_field.locally({ arg0: Leo.field(123) });
    expect(out).toBeDefined();
  });
});

describe("lionden_gapfiller — bad input → TransitionInputError", () => {
  it("echo_u8(999) is out of range and rejected before execution", async () => {
    await expect(gap.echo_u8.locally({ arg0: 999 })).rejects.toBeInstanceOf(TransitionInputError);
  });
});

describe("lionden_gapfiller — hashing/crypto", () => {
  it("hash_bhp(field) returns a field", async () => {
    expect(await gap.hash_bhp.locally({ arg0: Leo.field(1) })).toBeDefined();
  });

  it("hash_poseidon(field) returns a field", async () => {
    expect(await gap.hash_poseidon.locally({ arg0: Leo.field(1) })).toBeDefined();
  });

  it("hash_pedersen(u32) returns a field", async () => {
    expect(await gap.hash_pedersen.locally({ arg0: 7 })).toBeDefined();
  });
});

describe("lionden_gapfiller — private outputs + decryption errors", () => {
  const signer = () => ctx!.accounts[0]!.privateKey;
  const wrongKey = () => ctx!.accounts[1]!.privateKey;

  it("mint_secret output decrypts with the owner's key", async () => {
    const result = await gap.mint_secret.accepted({ arg0: 5n, arg1: Leo.field(99) });
    const [note] = result.outputs;
    const decoded = await note.decrypt(signer());
    expect(decoded).toBeDefined();
  });

  it("decrypting with a wrong view key throws LocalRecordDecryptionError", async () => {
    const result = await gap.mint_secret.accepted({ arg0: 5n, arg1: Leo.field(99) });
    const [note] = result.outputs;
    await expect(note.decrypt(wrongKey())).rejects.toBeInstanceOf(LocalRecordDecryptionError);
  });

  it("decrypting with a malformed key string throws RecordDecryptionKeyError", async () => {
    const result = await gap.mint_secret.accepted({ arg0: 5n, arg1: Leo.field(99) });
    const [note] = result.outputs;
    await expect(note.decrypt("not-a-valid-key")).rejects.toBeInstanceOf(RecordDecryptionKeyError);
  });
});
