/**
 * Argument parsing and the Leo-backend gate for `scripts/run-smoke-examples.mjs`.
 *
 * Split out of the runner so both can be unit-tested. The runner itself runs
 * example projects on import, which makes it untestable in-process, and the
 * deploy-backend flag is exactly the kind of thing that fails silently when
 * mis-parsed: a dropped value means the lane runs the *default* backend while
 * reporting that it ran the requested one.
 */

import { spawnSync } from "node:child_process";

export const DEPLOY_BACKENDS = ["sdk", "leo"];

/**
 * The only Leo line the Leo deploy backend supports. Kept in sync with
 * `LEO_DEPLOY_BACKEND_LINE` in `packages/plugin-deploy/src/leo-version.ts`.
 */
export const LEO_DEPLOY_BACKEND_LINE = "4.3";

export const USAGE =
  "Usage: node scripts/run-smoke-examples.mjs [--list] [--no-typecheck] [--prove] [--coverage]" +
  " [--deploy-backend <sdk|leo>] [core] [aleo-ports] [all]";

/**
 * A token that is a flag rather than a value.
 *
 * `--deploy-backend --prove` must be rejected as a missing value, not silently
 * swallow `--prove` as the backend name.
 */
function isFlag(token) {
  return token !== undefined && token.startsWith("-");
}

function assertKnownBackend(value) {
  if (value === undefined || value === "") {
    throw new Error(
      `--deploy-backend requires a value. Expected one of: ${DEPLOY_BACKENDS.join(", ")}.`,
    );
  }
  if (!DEPLOY_BACKENDS.includes(value)) {
    throw new Error(
      `Unknown deploy backend ${JSON.stringify(value)}. ` +
        `Expected one of: ${DEPLOY_BACKENDS.join(", ")}.`,
    );
  }
  return value;
}

export function parseArgs(args) {
  const parsed = {
    listOnly: false,
    typecheck: true,
    prove: false,
    coverage: false,
    deployBackend: undefined,
    groups: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--list":
        parsed.listOnly = true;
        break;
      case "--no-typecheck":
        parsed.typecheck = false;
        break;
      case "--prove":
        parsed.prove = true;
        break;
      case "--coverage":
        parsed.coverage = true;
        break;
      case "--deploy-backend": {
        // A trailing `--deploy-backend`, or one followed by another flag, is a
        // missing value — never an unset backend. Reading `args[++i]` blindly
        // would hand back `undefined` and skip validation entirely.
        const value = isFlag(args[i + 1]) ? undefined : args[++i];
        parsed.deployBackend = assertKnownBackend(value);
        break;
      }
      default:
        if (arg.startsWith("--deploy-backend=")) {
          parsed.deployBackend = assertKnownBackend(arg.slice("--deploy-backend=".length));
          break;
        }
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option "${arg}".`);
        }
        parsed.groups.push(arg);
        break;
    }
  }

  return parsed;
}

/** Injectable for tests; shaped like a `spawnSync` result. */
const defaultLeoVersionProbe = () =>
  spawnSync("leo", ["--disable-update-check", "--version"], { encoding: "utf8" });

/**
 * Refuse the Leo backend lane on an unsupported binary rather than skipping it.
 *
 * `--deploy-backend leo` is opt-in, so a silent skip would hand back a green
 * lane that exercised nothing — the failure mode this gate exists to prevent.
 * The backend enforces the same rule at runtime; checking here fails in one
 * second instead of after a full compile of every example.
 *
 * Probes bare `leo` rather than each config's `leoBinary`, matching the rest of
 * this runner — the smoke examples all use the binary on `PATH`. The backend's
 * own gate is the authoritative one and does read `leoBinary`.
 */
export function assertLeoDeployBackendSupported(probe = defaultLeoVersionProbe) {
  const result = probe();

  if (result.error || result.status !== 0) {
    throw new Error(
      `--deploy-backend leo requires a Leo ${LEO_DEPLOY_BACKEND_LINE}.x binary on PATH, but ` +
        `\`leo --version\` could not be run: ${result.error?.message ?? `exit ${result.status}`}.`,
    );
  }

  // The trailing lookahead (rather than `\b`) rejects pre-release and build
  // suffixes such as `4.3.2-rc1` or `4.3.2+build` — `\b` matches before `-`/`+`
  // and would pass a binary the backend's own gate (`parseLeoVersionOutput`)
  // rejects, failing the lane only after every example has compiled.
  const version = /\b(\d+)\.(\d+)\.(\d+)(?![-+.\w])/.exec(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );

  if (!version) {
    throw new Error(
      `--deploy-backend leo supports Leo ${LEO_DEPLOY_BACKEND_LINE}.x only, but no stable version ` +
        `could be parsed from \`leo --version\`. ` +
        `Install Leo ${LEO_DEPLOY_BACKEND_LINE}.x, or drop the flag to use the default SDK backend.`,
    );
  }

  if (`${version[1]}.${version[2]}` !== LEO_DEPLOY_BACKEND_LINE) {
    throw new Error(
      `--deploy-backend leo supports Leo ${LEO_DEPLOY_BACKEND_LINE}.x only, but \`leo --version\` ` +
        `reports ${version[0]}. ` +
        `Install Leo ${LEO_DEPLOY_BACKEND_LINE}.x, or drop the flag to use the default SDK backend.`,
    );
  }
}
