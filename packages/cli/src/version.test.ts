import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("lionden --version", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("prints the version from package.json", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "lionden", "--version"];
    await main();
    expect(log).toHaveBeenCalledWith(`lionden v${pkg.version}`);
  });
});
