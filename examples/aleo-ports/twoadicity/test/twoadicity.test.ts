import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTwoadicity } from "../typechain/Twoadicity.js";

async function deployTwoadicity() {
  const ctx = await setup();
  try {
    await ctx.deploy("twoadicity", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

const DEPLOY_TIMEOUT_MS = 420_000;
const LOCAL_TIMEOUT_MS = 320_000;

beforeAll(async () => {
  const fixture = await loadFixture(deployTwoadicity);
  ctx = fixture.ctx;
}, DEPLOY_TIMEOUT_MS);

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("twoadicity.aleo", () => {
  const twoadicity = createTwoadicity();

  beforeAll(() => {
    twoadicity.connect(ctx!.lre);
  });

  // The 252-bounded loop with field division is expensive even in local mode —
  // each call synthesizes a large circuit. We exercise a small representative
  // set of inputs (odd, low power-of-two, low non-power) rather than a
  // saturating sweep.
  it(
    "twoadicity(1) = 0 (odd)",
    async () => {
      expect(await twoadicity.main.locally(1n)).toBe(0);
    },
    LOCAL_TIMEOUT_MS,
  );

  it(
    "twoadicity(8) = 3 (2^3)",
    async () => {
      expect(await twoadicity.main.locally(8n)).toBe(3);
    },
    LOCAL_TIMEOUT_MS,
  );

  it(
    "twoadicity(12) = 2 (4·3)",
    async () => {
      expect(await twoadicity.main.locally(12n)).toBe(2);
    },
    LOCAL_TIMEOUT_MS,
  );
});
