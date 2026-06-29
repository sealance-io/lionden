// simple_token is the Pass-2 record-arg spike. The upstream example ships
// no run.sh and no leo-test, only inputs/mint.in + inputs/transfer.in:
//   mint.in:     <owner> 100u64
//   transfer.in: { owner: …private, amount: 100u64.private, _nonce: …group.public } <to> 50u64
//
// The chained-record pattern: mint() returns a typed Token, transfer() takes
// it back as input and returns the [remainder, transferred] pair.

import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSimpleToken } from "../typechain/SimpleToken.js";

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
  const token = createSimpleToken();
  const owner = () => ctx!.accounts[0]!;
  const recipient = () => ctx!.accounts[1]!;

  beforeAll(() => {
    token.connect(ctx!.lre);
  });

  it("mint produces a Token record assigned to the owner", async () => {
    const minted = await token.mint.locally({ arg0: owner(), arg1: 100n });

    expect(minted.owner).toBe(owner().address);
    expect(minted.amount).toBe(100n);
    expect(minted._nonce).toBeTruthy();
  });

  it("transfer splits a minted token into remainder + transferred", async () => {
    // Step 1: mint 100 to owner — produces Token #1.
    const minted = await token.mint.locally({ arg0: owner(), arg1: 100n });

    // Step 2: transfer 30 of it to recipient — should produce two records
    // (remaining: 70 to owner, transferred: 30 to recipient).
    const [remaining, transferred] = await token.transfer.locally({
      arg0: minted,
      arg1: recipient(),
      arg2: 30n,
    });

    expect(remaining.owner).toBe(owner().address);
    expect(remaining.amount).toBe(70n);

    expect(transferred.owner).toBe(recipient().address);
    expect(transferred.amount).toBe(30n);
  });
});
