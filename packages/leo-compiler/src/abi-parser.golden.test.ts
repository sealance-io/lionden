import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAbi } from "./abi-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "__fixtures__/abi");

const FIXTURE_PAIRS: [string, string][] = [
  // Leo 4.1 wire fixtures (the `__fixtures__/abi/*.abi.json` keep `"None"` and
  // explicit self-program refs — they exist to prove canonicalization).
  ["hello.abi.json", "hello.normalized.json"],
  ["token.abi.json", "token.normalized.json"],
  ["rewards.abi.json", "rewards.normalized.json"],
  ["treasury.abi.json", "treasury.normalized.json"],
  // Leo 4.2 wire fixtures: positional inputs (names dropped → synthesized as
  // `arg{i}`), bare enum I/O variants, explicit `program: "<self>.aleo"` self
  // refs, and unmoded plaintext. The `-v42` normalized goldens differ from the
  // 4.1 twins only by the synthesized input names — both canonicalize modes to
  // Private/Public and self-refs to null. (Do NOT assert byte-identity to the
  // 4.1 goldens; the names differ.)
  ["hello-v42.abi.json", "hello-v42.normalized.json"],
  ["token-v42.abi.json", "token-v42.normalized.json"],
  ["edge-v42.abi.json", "edge-v42.normalized.json"],
];

describe("parseAbi goldens", () => {
  for (const [fixtureFile, goldenFile] of FIXTURE_PAIRS) {
    it(`normalizes ${fixtureFile} to stable output`, async () => {
      const json = readFileSync(resolve(FIXTURES_DIR, fixtureFile), "utf-8");
      const abi = parseAbi(json);
      const normalized = JSON.stringify(abi, null, 2) + "\n";
      await expect(normalized).toMatchFileSnapshot(
        resolve(__dirname, "__goldens__/abi", goldenFile),
      );
    });
  }
});
