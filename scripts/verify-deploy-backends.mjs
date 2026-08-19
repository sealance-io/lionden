/**
 * Tier 4 — prove the SDK and Leo deploy backends produce equivalent results
 * against a real chain.
 *
 * This is the only place three things are checked:
 *
 * 1. **Normalized disk-backed record parity.** Example smoke suites run on
 *    ephemeral devnode state and write no records at all, and the Tier 2
 *    contract tests assert each backend's behaviour separately against a fake
 *    network. Neither compares the two backends' persisted output.
 * 2. **Real-chain dry-run purity.** `--dry-run` must produce a transaction and
 *    write nothing. Only the Leo backend can dry-run against a non-devnode
 *    build path at all.
 * 3. **The `--skip` closure on a real multi-program deploy**, and the rename
 *    subtraction from §5 — both of which fail *silently* (Leo exits 0 having
 *    built nothing) rather than loudly.
 *
 * Usage:
 *   node scripts/verify-deploy-backends.mjs            # all cases
 *   node scripts/verify-deploy-backends.mjs hello      # one case
 *   node scripts/verify-deploy-backends.mjs --list
 *
 * Requires a Leo 4.3.x binary on PATH and a free devnode port. Devnode-backed
 * steps run strictly one at a time — the devnode binds a fixed TCP port.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDevnode, stopDevnode } from "@lionden/testing";
import { assertLeoDeployBackendSupported } from "./lib/smoke-lane.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

/**
 * Fields that legitimately differ between two runs against two different
 * chains. Everything else must match exactly.
 *
 * `txId`/`blockHeight` are asserted separately for presence rather than
 * compared for equality — two independent chains will never agree on them.
 */
const VOLATILE_RECORD_FIELDS = ["txId", "blockHeight", "deployedAt", "updatedAt", "feePaid"];

const CASES = [
  {
    name: "hello",
    example: "hello-world",
    programs: ["hello"],
    /**
     * `zhello.aleo` *contains* `hello.aleo`. If the closure subtraction ever
     * stops removing the source root, `hello.aleo` stays in the skip list and
     * the collision guard fires — or, without the guard, Leo skips the very
     * program being deployed and exits 0 having built nothing. This case turns
     * that silent failure into a loud one.
     */
    rename: "hello:zhello",
  },
  {
    name: "multi-program",
    example: "multi-program",
    /**
     * `rewards` imports `treasury.aleo`, so deploying it forces one `--skip`
     * per local deployable dependency on the Leo backend — and each program
     * must still get exactly one record.
     *
     * `math_utils` is deliberately absent: it is a `lib.leo` library unit,
     * compiled into its consumers rather than deployed, so it is not a node in
     * the deployment closure and never appears in a skip list.
     */
    programs: ["treasury", "rewards"],
  },
];

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const c of CASES) console.log(c.name);
  process.exit(0);
}

const selected = args.length > 0 ? CASES.filter((c) => args.includes(c.name)) : CASES;
if (selected.length === 0) {
  console.error(`No matching cases. Available: ${CASES.map((c) => c.name).join(", ")}`);
  process.exit(1);
}

assertLeoDeployBackendSupported();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-verify-backends-"));
let failures = 0;

try {
  for (const testCase of selected) {
    console.log(`\n${"=".repeat(70)}\n== case: ${testCase.name}\n${"=".repeat(70)}`);
    if (!(await runCase(testCase))) failures++;
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} case(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll cases passed: SDK and Leo backends produced equivalent deployment state.");

async function runCase(testCase) {
  const exampleDir = path.join(repoRoot, "examples", testCase.example);
  const arms = ["sdk", "leo"];

  // Only our own directories, never the example's default `deployments/`.
  for (const backend of arms) {
    fs.rmSync(path.join(exampleDir, `deployments-${backend}`), { recursive: true, force: true });
  }

  const summaries = {};
  for (const backend of arms) {
    // A fresh chain per arm. Sharing one devnode means the second arm hits
    // `skipDeployed` plus the already-deployed preflight outcome and deploys
    // nothing, so the comparison would pass against an empty directory.
    console.log(`\n-- ${testCase.name}/${backend}: starting devnode from genesis`);
    const devnode = await startDevnode();
    try {
      summaries[backend] = runArm(testCase, backend, exampleDir);
    } finally {
      console.log(`-- ${testCase.name}/${backend}: stopping devnode`);
      await stopDevnode(devnode);
    }
  }

  return compareArms(testCase, exampleDir, summaries);
}

function runArm(testCase, backend, exampleDir) {
  const config = path.join("examples", testCase.example, `lionden.config.backend-${backend}.ts`);
  const outPath = path.join(tmpDir, `${testCase.name}-${backend}.json`);

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/cli/src/bin.ts",
      "--config",
      config,
      "run",
      path.join(scriptDir, "verify-deploy-backends-step.ts"),
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        LIONDEN_VERIFY_BACKEND: backend,
        LIONDEN_VERIFY_PROGRAMS: testCase.programs.join(","),
        ...(testCase.rename ? { LIONDEN_VERIFY_RENAME: testCase.rename } : {}),
        LIONDEN_VERIFY_OUT: outPath,
        // The step script selects the backend through config; make sure a
        // stray environment variable cannot override it.
        LIONDEN_DEPLOY_BACKEND: "",
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `${testCase.name}/${backend}: deploy arm exited ${result.status}. ` +
        `Its output is above; the parity comparison cannot run.`,
    );
  }

  if (!fs.existsSync(outPath)) {
    throw new Error(`${testCase.name}/${backend}: step script wrote no summary at ${outPath}.`);
  }

  return JSON.parse(fs.readFileSync(outPath, "utf8"));
}

/** Top-level records only — history filenames carry timestamps and differ. */
function readRecords(stateDir) {
  const records = {};
  if (!fs.existsSync(stateDir)) return records;

  for (const network of fs.readdirSync(stateDir, { withFileTypes: true })) {
    if (!network.isDirectory()) continue;
    const networkDir = path.join(stateDir, network.name);
    for (const file of fs.readdirSync(networkDir).sort()) {
      if (!file.endsWith(".json") || file.endsWith(".abi.json") || file.startsWith(".")) continue;
      records[`${network.name}/${file}`] = JSON.parse(
        fs.readFileSync(path.join(networkDir, file), "utf8"),
      );
    }
  }
  return records;
}

function normalize(record) {
  const copy = { ...record };
  for (const field of VOLATILE_RECORD_FIELDS) delete copy[field];
  return copy;
}

function compareArms(testCase, exampleDir, summaries) {
  const problems = [];
  const records = {};

  for (const backend of ["sdk", "leo"]) {
    records[backend] = readRecords(path.join(exampleDir, `deployments-${backend}`));

    if (Object.keys(records[backend]).length === 0) {
      problems.push(
        `${backend}: wrote no deployment records. Check that the parity config sets ` +
          `\`deploy.ephemeral: false\` — an ephemeral network records nothing and this ` +
          `comparison would pass vacuously.`,
      );
    }

    // Presence, not equality: two independent chains never agree on these.
    for (const [key, record] of Object.entries(records[backend])) {
      if (record.status !== "complete") {
        problems.push(`${backend}: ${key} has status "${record.status}", expected "complete".`);
      }
      if (!record.txId) problems.push(`${backend}: ${key} has no txId.`);
      if (record.blockHeight === undefined || record.blockHeight === null) {
        problems.push(`${backend}: ${key} has no blockHeight.`);
      }
    }
  }

  const sdkKeys = Object.keys(records.sdk).sort();
  const leoKeys = Object.keys(records.leo).sort();

  if (JSON.stringify(sdkKeys) !== JSON.stringify(leoKeys)) {
    problems.push(
      `record sets differ.\n    sdk: ${sdkKeys.join(", ") || "(none)"}\n    leo: ${leoKeys.join(", ") || "(none)"}`,
    );
  }

  const expectedRecordCount = testCase.programs.length + (testCase.rename ? 1 : 0);
  if (sdkKeys.length !== expectedRecordCount) {
    problems.push(
      `expected ${expectedRecordCount} record(s) per backend, sdk wrote ${sdkKeys.length}.`,
    );
  }

  for (const key of sdkKeys) {
    if (!records.leo[key]) continue;
    const sdk = JSON.stringify(normalize(records.sdk[key]), null, 2);
    const leo = JSON.stringify(normalize(records.leo[key]), null, 2);
    if (sdk !== leo) {
      problems.push(`${key} differs after normalization:\n  sdk: ${sdk}\n  leo: ${leo}`);
    }
  }

  if (summaries.leo?.dryRun) {
    console.log(
      `\n   dry-run (leo): built ${summaries.leo.dryRun.programIds.join(", ")}, ` +
        `state directory stayed empty`,
    );
  } else {
    problems.push("leo arm reported no dry-run result; dry-run purity was not checked.");
  }

  if (problems.length > 0) {
    console.error(`\n!! ${testCase.name}: FAILED`);
    for (const problem of problems) console.error(`   - ${problem}`);
    return false;
  }

  console.log(
    `\n   ${testCase.name}: OK — ${sdkKeys.length} record(s) identical after normalization ` +
      `(${sdkKeys.join(", ")})`,
  );
  return true;
}
