import { beforeEach, describe, expect, it } from "vitest";
import { clearFixtures, loadFixture } from "./fixtures.js";

describe("fixtures", () => {
  beforeEach(() => {
    clearFixtures();
  });

  it("executes fixture on first call", async () => {
    let calls = 0;
    const fixture = async () => {
      calls++;
      return { value: 42 };
    };

    const result = await loadFixture(fixture);
    expect(result).toEqual({ value: 42 });
    expect(calls).toBe(1);
  });

  it("returns cached result on subsequent calls", async () => {
    let calls = 0;
    const fixture = async () => {
      calls++;
      return { value: "cached" };
    };

    const first = await loadFixture(fixture);
    const second = await loadFixture(fixture);
    const third = await loadFixture(fixture);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(calls).toBe(1);
  });

  it("caches by function reference, not by name", async () => {
    let callsA = 0;
    let callsB = 0;

    const fixtureA = async () => {
      callsA++;
      return "A";
    };
    const fixtureB = async () => {
      callsB++;
      return "B";
    };

    const a = await loadFixture(fixtureA);
    const b = await loadFixture(fixtureB);

    expect(a).toBe("A");
    expect(b).toBe("B");
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
  });

  it("clearFixtures resets the cache", async () => {
    let calls = 0;
    const fixture = async () => {
      calls++;
      return calls;
    };

    const first = await loadFixture(fixture);
    expect(first).toBe(1);

    clearFixtures();

    const second = await loadFixture(fixture);
    expect(second).toBe(2);
  });

  it("handles concurrent calls to the same fixture", async () => {
    let calls = 0;
    const fixture = async () => {
      calls++;
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      return calls;
    };

    // Fire two concurrent loadFixture calls
    const [a, b] = await Promise.all([loadFixture(fixture), loadFixture(fixture)]);

    // Both should get the same result; fixture should execute only once
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("propagates errors from fixture function", async () => {
    const failing = async () => {
      throw new Error("fixture failed");
    };

    await expect(loadFixture(failing)).rejects.toThrow("fixture failed");
  });
});
