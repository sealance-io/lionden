import { describe, expectTypeOf, it } from "vitest";
import type { SignableNamedAccount } from "@lionden/config";
import type { Signer } from "@lionden/network";

describe("named account type compatibility", () => {
  it("allows signable named accounts wherever a network signer is expected", () => {
    expectTypeOf<SignableNamedAccount>().toMatchTypeOf<Signer>();
  });
});
