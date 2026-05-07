// simple_token is the Pass-2 record-arg spike. The upstream example ships
// no run.sh and no leo-test, only inputs/mint.in + inputs/transfer.in:
//   mint.in:     <owner> 100u64
//   transfer.in: { owner: …private, amount: 100u64.private, _nonce: …group.public } <to> 50u64
//
// The open question this port answers: can `result.outputs[0]` from a
// record-returning local execute be passed back as the next call's
// argument? If yes, the chained-record pattern unlocks the rest of Group B
// (auction, basic_bank, vote, token).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

async function deploySimpleToken() {
  const ctx = await setup();
  try {
    await ctx.deploy("simple_token", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deploySimpleToken);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("simple_token.aleo", () => {
  const owner = () => ctx!.accounts[0]!.address;
  const recipient = () => ctx!.accounts[1]!.address;

  it("mint produces a Token record assigned to the owner", async () => {
    const result = await ctx!.execute(
      "simple_token.aleo",
      "mint",
      [owner(), "100u64"],
      { mode: "local" },
    );

    // Sanity-check the record literal shape: contains owner address, amount, and _nonce.
    const tokenLiteral = result.outputs[0]!;
    expect(tokenLiteral).toContain(owner());
    expect(tokenLiteral).toContain("100u64");
    expect(tokenLiteral).toContain("_nonce");
  });

  it("transfer splits a minted token into remainder + transferred", async () => {
    // Step 1: mint 100 to owner — produces Token #1.
    const mintResult = await ctx!.execute(
      "simple_token.aleo",
      "mint",
      [owner(), "100u64"],
      { mode: "local" },
    );
    const token = mintResult.outputs[0]!;

    // Step 2: transfer 30 of it to recipient — should produce two records
    // (remaining: 70 to owner, transferred: 30 to recipient).
    const transferResult = await ctx!.execute(
      "simple_token.aleo",
      "transfer",
      [token, recipient(), "30u64"],
      { mode: "local" },
    );

    expect(transferResult.outputs).toHaveLength(2);
    const remaining = transferResult.outputs[0]!;
    const transferred = transferResult.outputs[1]!;

    // remaining stays with the original owner, with the difference.
    expect(remaining).toContain(owner());
    expect(remaining).toContain("70u64");

    // transferred goes to the recipient with the requested amount.
    expect(transferred).toContain(recipient());
    expect(transferred).toContain("30u64");
  });
});
