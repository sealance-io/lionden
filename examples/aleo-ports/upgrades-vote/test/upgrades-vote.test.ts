// Port of tmp/leo-examples/upgrades/vote/tests/test_vote_example.leo and
// tmp/leo-examples/upgrades/vote/basic_voting/tests/test_basic_voting.leo.
//
// Note: the upstream test_basic_voting.leo file calls basic_voting.aleo::main,
// which doesn't exist on basic_voting (it only exposes propose/vote). The
// upstream @should_fail variant therefore "passes" because the call itself
// fails, and the non-@should_fail @test script fails outright. The port
// preserves the meaningful tests (vote_example.aleo::main) and documents the
// upstream gap rather than reproducing a broken test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

async function deployVoteExample() {
  const ctx = await setup();
  // Deploying vote_example deploys its dependency basic_voting first
  // (topological ordering — see examples/multi-program/test/multi-program.test.ts).
  try {
    await ctx.deploy("vote_example", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployVoteExample);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("vote_example.aleo", () => {
  // Port of @test script test_it()
  it("main returns the sum", async () => {
    const result = await ctx!.execute(
      "vote_example.aleo",
      "main",
      ["1u32", "2u32"],
      { mode: "local" },
    );
    expect(result.outputs[0]).toBe("3u32");
  });

  // Port of @test @should_fail fn do_nothing(): the original asserts 5 == 3
  // inside Leo and expects it to fail. Translated to a TS-side negative.
  it("main does not return the wrong sum", async () => {
    const result = await ctx!.execute(
      "vote_example.aleo",
      "main",
      ["2u32", "3u32"],
      { mode: "local" },
    );
    expect(result.outputs[0]).not.toBe("3u32");
  });
});

// basic_voting.aleo exposes propose/vote (Final-returning), not main. The
// upstream test_basic_voting.leo file targets a nonexistent main fn — see the
// header comment. A real port of the voting flow would seed proposed_checksum
// and run two distinct signers through vote() to cross THRESHOLD; that's out
// of scope for this 1:1 leo-test parity port.
describe.skip("basic_voting.aleo (upstream test references nonexistent main fn)", () => {
  it.skip("placeholder", () => {});
});
