import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Leo } from "../typechain/BaseContract.js";
import { asGoldToken, createGoldToken } from "../typechain/GoldToken.js";
import { createTokenRouter } from "../typechain/TokenRouter.js";

const RUNTIME_PROGRAM_ID = "tenant_gold.aleo";
const RUNTIME_IMPORTS = [RUNTIME_PROGRAM_ID];

type DeployTaskResult = {
  readonly mode: "deploy";
  readonly results: readonly { readonly programId: string }[];
};

async function deployRenamedDynamicRecords() {
  const ctx = await setup();
  try {
    await ctx.deploy("token_router", { noCompile: true });

    const renamedDeploy = (await ctx.lre.tasks.run("deploy", {
      program: "gold_token",
      rename: "tenant_gold",
    })) as DeployTaskResult;

    expect(renamedDeploy.mode).toBe("deploy");
    expect(renamedDeploy.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ programId: RUNTIME_PROGRAM_ID })]),
    );

    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployRenamedDynamicRecords);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("renamed dynamic records", () => {
  const gold = createGoldToken({ programId: RUNTIME_PROGRAM_ID });
  const router = createTokenRouter({ imports: RUNTIME_IMPORTS });
  const asTenantGold = asGoldToken.forProgram(RUNTIME_PROGRAM_ID);

  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  beforeAll(() => {
    gold.connect(ctx!.lre);
    router.connect(ctx!.lre);
  });

  async function expectDemoTransferWorks(amount: bigint) {
    const accepted = await router.demo_transfer.accepted(
      Leo.identifier("tenant_gold"),
      alice(),
      amount,
      bob(),
    );

    expect(accepted.outputs.kind).toBe("idOnlyDynamicRecord");
    expect(accepted.outputs.type).toBe("record_dynamic");
    expect(accepted.outputs.id).toMatch(/^[0-9]+field$/);

    const transferred = await accepted.outputs
      .match(asTenantGold.output.from("transfer", 0))
      .decrypt(bob());
    expect(transferred.owner).toBe(bob().address);
    expect(transferred.amount).toBe(amount);
    expect(transferred.purity).toBe(24n);
  }

  it("executes dynamic-record dispatch against the renamed runtime program", async () => {
    expect(gold.sourceProgramId).toBe("gold_token.aleo");
    expect(gold.programId).toBe(RUNTIME_PROGRAM_ID);

    const minted = await gold.withSigner(alice()).mint_custom.accepted(alice(), 123n, 22n);
    const directToken = await minted.outputs.match(asTenantGold.output).decrypt(alice());
    expect(directToken.amount).toBe(123n);
    expect(directToken.purity).toBe(22n);

    await expectDemoTransferWorks(1000n);
  });

  it("upgrades the renamed deployment by runtime id and keeps dynamic dispatch working", async () => {
    const previousEdition = (await ctx!.connection.getProgramEdition(RUNTIME_PROGRAM_ID)) as number;
    const upgrade = await ctx!.lre.tasks.run("upgrade", { program: RUNTIME_PROGRAM_ID });
    expect(upgrade).toMatchObject({ programId: RUNTIME_PROGRAM_ID });
    const afterEdition = (await ctx!.connection.getProgramEdition(RUNTIME_PROGRAM_ID)) as number;
    expect(previousEdition + 1).toBe(afterEdition);

    const minted = await gold.withSigner(alice()).mint_custom.accepted(alice(), 123n, 22n);
    const directToken = await minted.outputs.match(asTenantGold.output).decrypt(alice());
    expect(directToken.amount).toBe(123n);
    expect(directToken.purity).toBe(22n);

    await expectDemoTransferWorks(1000n);
  });
});
