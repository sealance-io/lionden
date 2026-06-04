import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAbi } from "./abi-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "__fixtures__/abi");

const FIXTURE_PAIRS: [string, string][] = [
  ["hello.abi.json", "hello.normalized.json"],
  ["token.abi.json", "token.normalized.json"],
  ["rewards.abi.json", "rewards.normalized.json"],
  ["treasury.abi.json", "treasury.normalized.json"],
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
