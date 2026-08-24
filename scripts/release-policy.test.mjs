import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertFixedReleaseGroup, loadPublicPackages } from "./release-policy.mjs";

const publicPackages = loadPublicPackages();
const config = JSON.parse(readFileSync(".changeset/config.json", "utf8"));
const fixedGroup = assertFixedReleaseGroup(config, publicPackages);

assert.equal(publicPackages.length, 11);
assert.equal(fixedGroup.length, 11);
assert.ok(!fixedGroup.includes("@lionden/test-internals"));

console.log("Release policy test passed: 11 public packages share one fixed group.");
