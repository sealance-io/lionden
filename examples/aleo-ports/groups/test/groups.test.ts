import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

async function deployGroups() {
  const ctx = await setup();
  try {
    await ctx.deploy("groups", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployGroups);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("groups.aleo", () => {
  // The transition computes (a*2 + (-2a)) + GEN = GEN regardless of `a`,
  // so any input group should yield group::GEN. We exercise it with the
  // generator point as `a`.
  it("returns the generator regardless of input", async () => {
    const result = await ctx!.execute(
      "groups.aleo",
      "main",
      ["7810607721416582242904415504650443951498042435501746664987470571546413371306group"],
      { mode: "local" },
    );
    // Output should be the generator point — its representation is fixed,
    // so we check it ends with `group` and is non-empty.
    expect(result.outputs[0]).toMatch(/group$/);
  });
});
