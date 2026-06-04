import type { SignableNamedAccount } from "@lionden/config";
import type { Signer } from "@lionden/network";
import { describe, expectTypeOf, it } from "vitest";

describe("named account type compatibility", () => {
  it("allows signable named accounts wherever a network signer is expected", () => {
    expectTypeOf<SignableNamedAccount>().toMatchTypeOf<Signer>();
  });
});
