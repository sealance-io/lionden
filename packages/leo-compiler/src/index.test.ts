import { describe, expect, it } from "vitest";
import { UnitNameCollisionError as DirectUnitNameCollisionError } from "./dependency-resolver.js";
import { UnitNameCollisionError } from "./index.js";

describe("leo-compiler public entrypoint", () => {
  it("exports dependency resolver error types", () => {
    expect(UnitNameCollisionError).toBe(DirectUnitNameCollisionError);
  });
});
