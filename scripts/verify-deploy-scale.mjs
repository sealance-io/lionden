/**
 * Tier 4 acceptance test — the Leo deploy backend against its actual motivation.
 *
 * Every other lane proves the Leo backend behaves *equivalently* to the SDK on
 * programs the SDK can already handle. None of them proves the thing the
 * feature exists for: that a deployment too large for the SDK's monolithic WASM
 * key synthesis still succeeds. Without this, the feature is verified only
 * against cases that never needed it.
 *
 * The fixture (`scripts/gen-large-program.mjs`) has two shapes, and only one of
 * them separates the backends:
 *
 * - `wide` — one program at the largest size snarkVM accepts. **Benchmark
 *   only.** Measured: the SDK deploys it in ~5 minutes. The per-program cap of
 *   2,097,152 variables sits below the SDK's ceiling, so no chain-valid program
 *   of this shape can separate the two. `--shape wide` runs as a benchmark and
 *   asserts only the Leo arm.
 * - `closure` — several heavy libraries plus a thin program importing them all.
 *   The chain caps one *program*; the SDK's ~4 GiB WASM ceiling caps one
 *   *deployment*, whose key material spans the whole import closure. This is
 *   the acceptance case, and it asserts both arms. Measured on the committed
 *   4-library fixture: Leo deploys `scale_probe.aleo` in 0.9 minutes, peaking at
 *   4.72 GB across its process tree; the SDK wants about the same, pins around
 *   4.8-4.9 GB against WASM's 4 GiB ceiling, and never returns. The difference
 *   is not how much memory each needs — it is which of them is allowed to have
 *   it.
 *
 * How a `closure` run is staged, and why:
 *
 * 1. Fresh devnode, then the libraries are deployed **with the Leo backend on
 *    both arms**. This is setup, not the thing under test: both arms then face
 *    an identical chain, and the measured step is the one deployment whose
 *    closure is the point. Using Leo here does not advantage the SDK arm — the
 *    SDK keeps no on-disk key cache (`resumableKeySynthesis: false`) and runs
 *    in a separate process, so it re-synthesizes from source either way.
 * 2. `deploy --program scale_probe` under the arm's backend. Its dependencies
 *    are already recorded, so `skipDeployed` narrows the run to that one
 *    program.
 *
 * `--prove` is mandatory, not a thoroughness knob. Both backends take a devnode
 * fast path that skips proof generation — the SDK through `buildDevnode*`, Leo
 * through `--skip-deploy-certificate` — and key synthesis is the *only* place
 * the ceiling lives. Without `--prove` this fixture deploys in seconds on both
 * arms and proves nothing.
 *
 * Usage:
 *   node scripts/verify-deploy-scale.mjs                 # both arms
 *   node scripts/verify-deploy-scale.mjs --skip-sdk      # Leo arm only (fast)
 *   node scripts/verify-deploy-scale.mjs --sdk-timeout 900000
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDevnode, stopDevnode } from "@lionden/testing";
import { assertLeoDeployBackendSupported } from "./lib/smoke-lane.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const fixtureDir = path.join(repoRoot, "test", "fixtures", "deploy-scale");
const configPath = path.join("test", "fixtures", "deploy-scale", "lionden.config.ts");
const stateDir = path.join(fixtureDir, "deployments");
const programsDir = path.join(fixtureDir, "programs");

/**
 * Long enough that a healthy SDK would have finished: the `wide` benchmark's
 * ~2.05M variables take it 5.1 minutes, and this closure is comparable work, so
 * 15 minutes is roughly 3x a successful run. Measured, the SDK's resident set
 * goes flat within ~7 minutes and never moves again.
 */
const DEFAULT_SDK_TIMEOUT_MS = 900_000;
const LEO_TIMEOUT_MS = 3_600_000;

/**
 * Floor for "the SDK arm failed *because* it ran out of room". Measured peak is
 * 4.8–4.9 GB; anything far below that is a different failure wearing the same
 * exit code.
 */
const WALL_EVIDENCE_KB = 3 * 1024 * 1024;
const PROBE = "scale_probe";

function parseArgs(argv) {
  const parsed = { skipSdk: false, sdkTimeoutMs: DEFAULT_SDK_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--skip-sdk") parsed.skipSdk = true;
    else if (argv[i] === "--sdk-timeout") parsed.sdkTimeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown option "${argv[i]}".`);
  }
  if (!Number.isInteger(parsed.sdkTimeoutMs) || parsed.sdkTimeoutMs < 1) {
    throw new Error("--sdk-timeout must be a positive integer (ms).");
  }
  return parsed;
}

/** Read the generated fixture back rather than taking the shape on faith. */
function readFixture() {
  const probeSource = path.join(programsDir, PROBE, "main.leo");
  if (!fs.existsSync(probeSource)) {
    throw new Error(
      `Scale fixture missing at ${path.relative(repoRoot, probeSource)}. ` +
        `Generate it with \`node scripts/gen-large-program.mjs\`.`,
    );
  }
  const summary = fs
    .readFileSync(probeSource, "utf8")
    .split("\n")[1]
    .replace(/^\/\/\s*/, "");
  const shape = summary.match(/shape=(\w+)/)?.[1];
  if (shape !== "wide" && shape !== "closure") {
    throw new Error(`Could not read a known shape from the fixture header: ${summary}`);
  }
  const libs = fs
    .readdirSync(programsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== PROBE)
    .map((entry) => entry.name)
    .sort();
  return { summary, shape, libs };
}

const { skipSdk, sdkTimeoutMs } = parseArgs(process.argv.slice(2));
const fixture = readFixture();

console.log(`== Leo deploy backend scale acceptance ==\nFixture: ${fixture.summary}`);
if (fixture.shape === "wide") {
  console.log(
    "Shape is `wide`: benchmark only. The SDK arm is reported, not asserted — no chain-valid\n" +
      "program of this shape can separate the backends. Use --shape closure for the acceptance\n" +
      "case (see scripts/gen-large-program.mjs).",
  );
}

assertLeoDeployBackendSupported();

/**
 * Peak resident set of a process *and every descendant*.
 *
 * Sampling only the LionDen pid would be right for the SDK arm, whose work is
 * in-process WASM, and wrong for the Leo arm, whose work is in a `leo` child —
 * it would report the parent's idle footprint and call it Leo's cost. One `ps`
 * snapshot, then walk the pid tree.
 */
function treeRssKb(rootPid) {
  let out;
  try {
    out = execFileSync("ps", ["-Ao", "pid=,ppid=,rss="], { encoding: "utf8" });
  } catch {
    return 0;
  }
  const children = new Map();
  const rss = new Map();
  for (const line of out.split("\n")) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid)) continue;
    rss.set(pid, kb || 0);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  let total = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

/**
 * Run one `lionden` invocation, sampling RSS so the report can say *how* the
 * SDK arm failed. A WASM allocation failure and a long stall look the same from
 * an exit code; peak RSS is what distinguishes them.
 */
function runLionden({ args, backend, timeoutMs, label }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "packages/cli/src/bin.ts", "--config", configPath, "--prove", ...args],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env, LIONDEN_DEPLOY_BACKEND: backend },
      },
    );

    let peakRssKb = 0;
    const sampler = setInterval(() => {
      peakRssKb = Math.max(peakRssKb, treeRssKb(child.pid));
    }, 5_000);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (status, signal) => {
      clearInterval(sampler);
      clearTimeout(timer);
      resolve({
        label,
        backend,
        status,
        signal,
        timedOut,
        peakRssKb,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

async function runArm(backend, timeoutMs) {
  fs.rmSync(stateDir, { recursive: true, force: true });

  console.log(`\n-- ${backend}: starting devnode from genesis`);
  const devnode = await startDevnode();
  try {
    if (fixture.shape === "closure") {
      for (const lib of fixture.libs) {
        console.log(`-- ${backend}: setup — deploying ${lib} (Leo backend, both arms)`);
        const setup = await runLionden({
          args: ["deploy", "--program", lib],
          backend: "leo",
          timeoutMs: LEO_TIMEOUT_MS,
          label: `setup:${lib}`,
        });
        if (setup.status !== 0) {
          return { ...setup, records: readRecords(), setupFailed: lib };
        }
      }
    }

    console.log(`\n-- ${backend}: deploying ${PROBE} (measured)`);
    const measured = await runLionden({
      args: fixture.shape === "closure" ? ["deploy", "--program", PROBE] : ["deploy"],
      backend,
      timeoutMs,
      label: backend,
    });
    return { ...measured, records: readRecords() };
  } finally {
    console.log(`-- ${backend}: stopping devnode`);
    await stopDevnode(devnode);
  }
}

function readRecords() {
  const records = [];
  if (!fs.existsSync(stateDir)) return records;
  for (const network of fs.readdirSync(stateDir, { withFileTypes: true })) {
    if (!network.isDirectory()) continue;
    const dir = path.join(stateDir, network.name);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json") || file.endsWith(".abi.json") || file.startsWith(".")) continue;
      records.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
    }
  }
  return records;
}

function probeDeployed(arm) {
  return arm.records.some(
    (record) => record.programId === `${PROBE}.aleo` && record.status === "complete" && record.txId,
  );
}

function minutes(ms) {
  return `${(ms / 60_000).toFixed(1)}m`;
}

function gigabytes(kb) {
  return kb > 0 ? `${(kb / 1024 / 1024).toFixed(2)} GB` : "unmeasured";
}

/**
 * Signals an allocator that has run out of room dies by: `SIGABRT` from a WASM
 * abort, `SIGKILL` from the OS out-of-memory killer. Recognized alongside the
 * timeout because a future SDK may fail fast where today's hangs — and if it
 * fails some *other* way, this lane should say so rather than quietly accept it.
 */
const OOM_SIGNALS = new Set(["SIGABRT", "SIGKILL"]);

function ranOutOfRoom(arm) {
  return arm.timedOut || OOM_SIGNALS.has(arm.signal);
}

function describe(arm) {
  return (
    `exit ${arm.status ?? "none"}${arm.signal ? ` (signal ${arm.signal})` : ""}` +
    `${arm.timedOut ? " TIMED OUT" : ""} in ${minutes(arm.elapsedMs)}, ` +
    `peak RSS ${gigabytes(arm.peakRssKb)}`
  );
}

const failures = [];

const leo = await runArm("leo", LEO_TIMEOUT_MS);
console.log(`\nleo: ${describe(leo)}`);
if (leo.setupFailed) {
  failures.push(
    `Setup deployment of ${leo.setupFailed} failed, so the run never reached ${PROBE}. ` +
      `If Leo reported "exceeds the limit of ... for deployment", a single library outgrew the ` +
      `per-program cap — regenerate with fewer --rounds and more --libs.`,
  );
} else {
  // All three, not just the record: a run that writes the record and then dies
  // on export, cleanup, or a hook has not shown that the deployment path works.
  if (!probeDeployed(leo)) {
    failures.push(
      `leo arm did not deploy ${PROBE}. Records: ${JSON.stringify(leo.records.map((r) => r.programId))}`,
    );
  }
  if (leo.status !== 0) {
    failures.push(
      `leo arm exited ${leo.status ?? "none"}${leo.signal ? ` (signal ${leo.signal})` : ""} ` +
        `rather than 0.`,
    );
  }
  if (leo.timedOut) {
    failures.push(`leo arm hit its ${minutes(LEO_TIMEOUT_MS)} timeout.`);
  }
}

let sdk;
if (skipSdk) {
  console.log("\nsdk: skipped (--skip-sdk)");
} else {
  console.log(
    `\n-- sdk arm: bounded at ${minutes(sdkTimeoutMs)}. A hang or an out-of-memory abort here is ` +
      `the expected result.`,
  );
  sdk = await runArm("sdk", sdkTimeoutMs);
  console.log(`\nsdk: ${describe(sdk)}`);

  if (sdk.setupFailed) {
    failures.push(`Setup deployment of ${sdk.setupFailed} failed on the sdk arm's chain.`);
  } else if (probeDeployed(sdk)) {
    const message = `the SDK also deployed ${PROBE}, so this run does not demonstrate the memory wall.`;
    if (fixture.shape === "closure") {
      failures.push(
        `${message} Enlarge the import closure — it is the sum that matters, and each library ` +
          `still has to stay under the per-program cap:\n` +
          `      node scripts/gen-large-program.mjs --shape closure --libs 6 --rounds 180`,
      );
    } else {
      console.log(`\nNOTE: ${message} Expected for --shape wide; see the header of this file.`);
    }
  } else if (fixture.shape === "closure") {
    // "The SDK did not deploy it" is far weaker than the claim being made, and
    // on its own would be satisfied by a missing binary or a devnode hiccup.
    // Two independent things have to corroborate the memory wall: the run never
    // came back (or was killed the way an exhausted allocator gets killed), and
    // the resident set says why.
    if (!ranOutOfRoom(sdk)) {
      failures.push(
        `The sdk arm did not deploy ${PROBE}, but it also returned on its own ` +
          `(${describe(sdk)}). The memory wall shows up as a run that never finishes, or as a ` +
          `kill by ${[...OOM_SIGNALS].join("/")}. This is a different failure — read the output ` +
          `above rather than recording it as the wall.`,
      );
    }
    if (sdk.peakRssKb < WALL_EVIDENCE_KB) {
      failures.push(
        `The sdk arm did not deploy ${PROBE}, but peaked at only ${gigabytes(sdk.peakRssKb)} — ` +
          `below the ${gigabytes(WALL_EVIDENCE_KB)} that reaching the WASM ceiling produces on ` +
          `this fixture. It failed for some other reason.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

if (fixture.shape === "closure" && !skipSdk) {
  console.log(
    `\nPASS: ${PROBE}.aleo deploys through the Leo backend and does not through the SDK — ` +
      `the same chain-valid program, equivalent chains from the same genesis, under --prove.`,
  );
} else {
  console.log(`\nPASS: ${PROBE}.aleo deploys through the Leo backend under --prove.`);
}
