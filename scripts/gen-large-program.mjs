/**
 * Generate the Tier 4 scale fixture for `scripts/verify-deploy-scale.mjs`.
 *
 * The Leo deploy backend exists for one reason: the SDK synthesizes and retains
 * proving keys for a whole deployment in a single WASM operation, so a large
 * enough deployment exhausts WASM's ~4 GiB ceiling and hangs before control
 * returns to JavaScript. A feature justified by that failure mode has to be
 * tested against a deployment that actually reaches it, rather than only
 * against the small programs every other lane uses.
 *
 * Generated rather than hand-written because size is the whole point and needs
 * to be a knob. Weight comes from chained BHP256 hashes — each round is a full
 * hash circuit, so cost scales as functions x rounds while the source stays
 * small.
 *
 * Two shapes, because the obvious one does not work:
 *
 *   node scripts/gen-large-program.mjs --shape wide
 *   node scripts/gen-large-program.mjs --shape closure   # default
 *
 * Read `WIDE_NOTES` before reaching for `--shape wide`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const programsDir = path.join(repoRoot, "test", "fixtures", "deploy-scale", "programs");

/**
 * Leo rejects more than 31 entry-point `fn`s per program, so a single program's
 * function count is pinned at the ceiling and all remaining weight has to come
 * from `rounds`.
 */
const MAX_TRANSITIONS = 31;

/**
 * snarkVM's per-program deployment cap. A program above it is refused by the
 * chain itself, so neither backend can deploy it and its failure says nothing
 * about either. The cap is per *program*, which is the entire reason the
 * `closure` shape exists.
 */
const MAX_PROGRAM_VARIABLES = 2_097_152;

/**
 * `--shape wide`: one program, as many variables as the chain will take.
 *
 * Measured on this shape (Leo 4.3.2, snarkVM 4.8.1, testnet), with `--prove`:
 *
 * | rounds | variables | chain    | leo    | sdk               |
 * |--------|-----------|----------|--------|-------------------|
 * | 20     | ~2,047k   | accepts  | 1.1m   | 5.1m — succeeds   |
 * | 24     | 2,336,521 | REFUSES  | —      | hung, 4.76 GB     |
 * | 40     | 3,493,689 | REFUSES  | —      | hung, 4.79 GB     |
 *
 * 20 rounds is therefore the largest deployable instance of this shape — 21
 * already crosses the cap. The SDK deploys it, so **this shape cannot separate
 * the two backends below the chain's own limit.** It is kept because it is
 * still a useful upper-bound benchmark, but it is not the acceptance case.
 *
 * The way out is that `MAX_PROGRAM_VARIABLES` bounds one *program*, while the
 * SDK's ceiling bounds one *deployment* — and a deployment's key material
 * includes every uncached import in the call graph. See `CLOSURE_NOTES`.
 */
const WIDE_NOTES = "see the comment above WIDE_DEFAULTS";
const WIDE_DEFAULTS = { transitions: MAX_TRANSITIONS, rounds: 20 };

/**
 * `--shape closure`: several heavy library programs plus a thin program that
 * imports them all.
 *
 * Deploying the thin program requires the verifying key of every function it
 * calls across programs, and neither snarkVM nor the SDK can take those from
 * the chain — they are re-synthesized from source. So the deployment's key
 * material is the sum over the whole import closure, while the *program* being
 * deployed stays far below `MAX_PROGRAM_VARIABLES` and the chain is happy.
 *
 * Each library is deliberately a single `fn`: only the functions actually
 * called need keys, so concentrating a library's weight in one called function
 * makes every generated variable count toward the wall.
 *
 * This is not a contrived arrangement. It is what a project looks like once it
 * has a few deployed libraries and deploys something that composes them, and
 * it is the case Leo's `~/.aleo` cache is built for: the libraries' keys are
 * already on disk from their own deployments.
 *
 * Measured on this shape (Leo 4.3.2, snarkVM 4.8.1, testnet), with `--prove`,
 * deploying `scale_probe.aleo` onto a chain that already has the libraries.
 * Every library is far below the per-program cap, so the chain accepts all of
 * these; the only thing changing is the size of the closure:
 *
 * Peak RSS is summed over the whole process tree — the Leo arm's work happens
 * in a `leo` child, so a single-pid sample reports its parent's idle footprint
 * instead (~0.65 GB) and badly understates it.
 *
 * | libs | closure vars | leo                   | sdk                        |
 * |------|--------------|-----------------------|----------------------------|
 * | 2    | ~1.2M        | —                     | 4.6m, 4.52 GB — succeeds   |
 * | 4    | ~2.4M        | 0.9m, 4.72 GB — OK    | never returns, 4.8–4.9 GB  |
 *
 * At 4 libraries the SDK's resident set goes flat around 4.8–4.9 GB after some
 * seven minutes and stays there for the rest of the run: this is the ~4 GiB
 * WASM ceiling, reached inside one `buildDeploymentTransaction` call with
 * nothing to resume from.
 *
 * Note that Leo's demand is *comparable* — the split is not that Leo needs less
 * memory but that it can have it, being a native 64-bit process rather than a
 * 32-bit WASM one. What `~/.aleo` buys is the 54 seconds: the libraries' keys
 * are already on disk from their own deployments, so nothing is re-derived.
 *
 * Four is therefore the committed size: the smallest closure that clears the
 * wall, keeping the lane's runtime down.
 */
const CLOSURE_NOTES = "see the comment above CLOSURE_DEFAULTS";
const CLOSURE_DEFAULTS = { libs: 4, rounds: 180 };

function parseArgs(argv) {
  let shape = "closure";
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--shape") shape = argv[++i];
    else if (flag === "--transitions" || flag === "--rounds" || flag === "--libs") {
      raw[flag.slice(2)] = Number(argv[++i]);
    } else throw new Error(`Unknown option "${flag}".`);
  }
  if (shape !== "wide" && shape !== "closure") {
    throw new Error(`--shape must be "wide" or "closure", got ${JSON.stringify(shape)}.`);
  }

  const defaults = shape === "wide" ? WIDE_DEFAULTS : CLOSURE_DEFAULTS;
  for (const key of Object.keys(raw)) {
    if (!(key in defaults)) {
      throw new Error(`--${key} does not apply to --shape ${shape}.`);
    }
  }
  const parsed = { shape, ...defaults, ...raw };

  for (const [key, value] of Object.entries(parsed)) {
    if (key === "shape") continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`--${key} must be a positive integer, got ${value}.`);
    }
  }
  if (parsed.transitions > MAX_TRANSITIONS) {
    throw new Error(
      `--transitions cannot exceed ${MAX_TRANSITIONS}: Leo rejects a program with more entry ` +
        `points ("Reduce the program to at most ${MAX_TRANSITIONS} entry point fns"). ` +
        `Raise --rounds instead.`,
    );
  }
  if (parsed.libs > MAX_TRANSITIONS) {
    throw new Error(
      `--libs cannot exceed ${MAX_TRANSITIONS}: the probe needs one entry point per library.`,
    );
  }
  return parsed;
}

/** A weighted function body: `rounds` chained BHP256 hash circuits. */
function weightedFn(name, index, rounds) {
  const lines = [
    `    /// ${rounds} chained BHP256 hash circuits.`,
    `    fn ${name}(seed: field, salt: field) -> field {`,
    `        let acc: field = seed + ${index}field;`,
  ];
  for (let round = 0; round < rounds; round++) {
    lines.push(`        acc = BHP256::hash_to_field(acc + salt + ${round}field);`);
  }
  lines.push("        return acc;", "    }");
  return lines.join("\n");
}

function header(summary) {
  return `// GENERATED by scripts/gen-large-program.mjs — do not edit by hand.
// ${summary}
`;
}

function renderWide({ transitions, rounds }) {
  const body = Array.from({ length: transitions }, (_, i) =>
    weightedFn(`work_${i}`, i, rounds),
  ).join("\n\n");
  return {
    [`scale_probe/main.leo`]: `${header(`shape=wide transitions=${transitions} rounds=${rounds}`)}//
// Sized to the largest single program snarkVM will accept for deployment
// (${MAX_PROGRAM_VARIABLES.toLocaleString()} variables). Benchmark only — the SDK deploys this too.

program scale_probe.aleo {
    @noupgrade
    constructor() {}

${body}
}
`,
  };
}

function renderClosure({ libs, rounds }) {
  const files = {};
  for (let i = 0; i < libs; i++) {
    files[`scale_lib_${i}/main.leo`] = `${header(`shape=closure lib=${i} rounds=${rounds}`)}//
// One heavy entry point. Deploys on its own without trouble on either backend;
// the weight matters only when scale_probe.aleo imports it.

program scale_lib_${i}.aleo {
    @noupgrade
    constructor() {}

${weightedFn("work", i, rounds)}
}
`;
  }

  const imports = Array.from({ length: libs }, (_, i) => `import scale_lib_${i}.aleo;`).join("\n");
  const calls = Array.from(
    { length: libs },
    (_, i) =>
      `    fn use_${i}(seed: field, salt: field) -> field {\n` +
      `        return scale_lib_${i}.aleo::work(seed, salt);\n` +
      `    }`,
  ).join("\n\n");

  files["scale_probe/main.leo"] = `${header(`shape=closure libs=${libs} rounds=${rounds}`)}//
// Tiny on its own — every entry point is a single external call — but
// deploying it needs a verifying key for each imported function, and those are
// re-synthesized from source rather than read back from the chain. That makes
// the deployment's key material the sum of the whole closure while the program
// itself stays far below the ${MAX_PROGRAM_VARIABLES.toLocaleString()}-variable chain cap.

${imports}

program scale_probe.aleo {
    @noupgrade
    constructor() {}

${calls}
}
`;
  return files;
}

const options = parseArgs(process.argv.slice(2));
const files = options.shape === "wide" ? renderWide(options) : renderClosure(options);

// The fixture config deploys every program under `programs/`, so a leftover
// directory from the other shape would silently join the run.
fs.rmSync(programsDir, { recursive: true, force: true });
for (const [relative, contents] of Object.entries(files)) {
  const target = path.join(programsDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

console.log(
  `Wrote ${Object.keys(files).length} program(s) under ` +
    `${path.relative(repoRoot, programsDir)} (shape=${options.shape}).`,
);
if (options.shape === "wide") {
  console.log(
    `Keep the compiled program under ${MAX_PROGRAM_VARIABLES.toLocaleString()} variables — past ` +
      `that the chain refuses the deployment and neither backend can succeed (${WIDE_NOTES}).`,
  );
} else {
  console.log(
    `Each library stays well under the per-program cap; the wall comes from their sum at ` +
      `scale_probe deploy time (${CLOSURE_NOTES}).`,
  );
}
