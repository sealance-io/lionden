// Port of tmp/leo-examples/example_with_test/tests/test_example_program.leo
// — the canonical "leo test" demo, translated to lionden's TS testing surface.

import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExampleProgram } from "../typechain/ExampleProgram.js";

async function deployExample() {
  const ctx = await setup();
  try {
    await ctx.deploy("example_program", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployExample);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("example_program.aleo", () => {
  const example = createExampleProgram();

  beforeAll(() => {
    example.connect(ctx!.lre);
  });

  // Port of @test fn test_simple_addition()
  it("simple_addition returns the sum", async () => {
    expect(await example.simple_addition.locally({ arg0: 2, arg1: 3 })).toBe(5);
  });

  // Port of @test @should_fail fn test_simple_addition_fail()
  // The original asserts 2+3 == 3 inside Leo and expects assert_eq to fail.
  // In lionden, simple_addition runs successfully and returns 5; the
  // failure assertion lives in the test layer.
  it("simple_addition does not return the wrong sum (parity for @should_fail)", async () => {
    expect(await example.simple_addition.locally({ arg0: 2, arg1: 3 })).not.toBe(3);
  });

  // Port of @test fn test_record_maker()
  it("mint_record produces a record with the requested x field", async () => {
    const record = await example.mint_record.locally({ arg0: 0n });
    expect(record.x).toBe("0field");
  });

  // Port of @test script test_async() — first half only.
  // The Leo script does:
  //   let fin = example_program.aleo::set_mapping(12field);
  //   fin.run();
  //   assert_eq(Mapping::get(map, 0field), 12field);
  //
  // The trailing block — `Mapping::set(map, VAL, rand_val); ChaCha::rand_field()`
  // — has no equivalent in @lionden/testing (ctx.execute can only invoke
  // transitions; there is no way to seed a mapping or call ChaCha directly).
  // NOTE: leo-test parity gap. See tmp/leo-examples/example_with_test/tests/test_example_program.leo:34-38.
  it("set_mapping writes through finalize and is readable from the mapping", async () => {
    await example.set_mapping.accepted({ arg0: 12n });
    expect(await example.mappings.map.get(0n)).toBe("12field");
  });
});
