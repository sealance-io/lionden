#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: scripts/recompile-examples.sh [all|core|aleo-ports] [--dry-run]\n' >&2
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

group="all"
dry_run=0
group_seen=0

for arg in "$@"; do
  case "$arg" in
    all|core|aleo-ports)
      if [[ "$group_seen" -eq 1 ]]; then
        usage
        exit 2
      fi
      group="$arg"
      group_seen=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.nvm/nvm.sh"
    nvm use >/dev/null
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'node is required. Install Node.js or make nvm available.\n' >&2
  exit 1
fi

cleanup_example() {
  local config_rel="$1"
  local dry_run_flag="$2"

  (
    cd "$repo_root"
    node --import tsx --input-type=module - "$config_rel" "$dry_run_flag" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [configRel, dryRunFlag] = process.argv.slice(2);
const dryRun = dryRunFlag === "1";
const repoRoot = process.cwd();

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  if (!configRel) {
    throw new Error("Missing config path.");
  }

  const configPath = path.resolve(repoRoot, configRel);
  const configDiscovery = await import(
    pathToFileURL(path.join(repoRoot, "packages/cli/src/config-discovery.ts")).href
  );
  const core = await import(
    pathToFileURL(path.join(repoRoot, "packages/core/src/index.ts")).href
  );

  const { config: rawConfig, projectRoot } =
    await configDiscovery.loadConfigFile(configPath);
  const plugins = core.resolvePluginOrder(rawConfig.plugins ?? []);
  const { resolved } = await core.resolveConfig(rawConfig, plugins, projectRoot);

  const targets = buildCleanupTargets(resolved);
  const validatedTargets = targets.map((target) =>
    validateCleanupTarget(target, resolved, projectRoot),
  );

  console.log("    cleanup targets:");
  for (const target of validatedTargets) {
    const status = target.exists ? "" : " (missing)";
    console.log(`      ${formatPath(target.abs)}${status}`);
  }

  if (dryRun) {
    console.log("    dry-run: no files deleted");
    return;
  }

  for (const target of validatedTargets) {
    if (!target.exists) continue;
    fs.rmSync(target.abs, { recursive: true, force: true });
  }
}

function buildCleanupTargets(config) {
  const targets = [
    { abs: config.paths.artifacts },
    { abs: config.paths.typechain },
  ];

  const devnodeNetworkNames = Object.entries(config.networks)
    .filter(([, network]) => network.type === "devnode")
    .map(([name]) => name);

  for (const networkName of devnodeNetworkNames) {
    targets.push(
      { abs: path.join(config.paths.deployments, networkName) },
      { abs: path.join(config.paths.deployments, "_exports", `${networkName}.json`) },
    );
  }

  targets.push(
    { abs: path.join(config.paths.deployments, "devnet") },
    { abs: path.join(config.paths.deployments, "_exports", "devnet.json") },
  );

  const uniqueTargets = new Map();
  for (const target of targets) {
    uniqueTargets.set(path.resolve(target.abs), target);
  }
  return [...uniqueTargets.values()];
}

function validateCleanupTarget(target, config, exampleRoot) {
  const abs = path.resolve(target.abs);
  const root = path.resolve(exampleRoot);
  const programs = path.resolve(config.paths.programs);

  if (abs === root) {
    throw new Error(`Refusing to delete example root: ${formatPath(abs)}`);
  }
  if (!isStrictlyInside(root, abs)) {
    throw new Error(
      `Refusing to delete target outside example root: ${formatPath(abs)}`,
    );
  }
  if (pathsOverlap(abs, programs)) {
    throw new Error(
      `Refusing to delete target that overlaps programs dir: ${formatPath(abs)}`,
    );
  }

  const trackedFiles = gitTrackedFiles(abs);
  if (trackedFiles.length > 0) {
    throw new Error(
      [
        `Refusing to delete target containing tracked files: ${formatPath(abs)}`,
        ...trackedFiles.map((file) => `  - ${file}`),
      ].join("\n"),
    );
  }

  const lstat = maybeLstat(abs);
  if (!lstat) {
    return { abs, exists: false };
  }
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to delete symlink target: ${formatPath(abs)}`);
  }

  const rootReal = fs.realpathSync(root);
  const targetReal = fs.realpathSync(abs);
  if (targetReal === rootReal || !isStrictlyInside(rootReal, targetReal)) {
    throw new Error(
      `Refusing to delete target whose real path escapes example root: ${formatPath(abs)}`,
    );
  }

  const programsReal = maybeRealpath(programs);
  if (programsReal && pathsOverlap(targetReal, programsReal)) {
    throw new Error(
      `Refusing to delete target whose real path overlaps programs dir: ${formatPath(abs)}`,
    );
  }

  return { abs, exists: true };
}

function gitTrackedFiles(abs) {
  const rel = path.relative(repoRoot, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Cleanup target is outside the git worktree: ${formatPath(abs)}`);
  }

  const result = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--", toPosix(rel)],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit status ${result.status}`;
    throw new Error(`git ls-files failed for ${formatPath(abs)}: ${detail}`);
  }

  return result.stdout.split("\0").filter(Boolean);
}

function maybeLstat(abs) {
  try {
    return fs.lstatSync(abs);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function maybeRealpath(abs) {
  try {
    return fs.realpathSync(abs);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function pathsOverlap(a, b) {
  return isSameOrInside(a, b) || isSameOrInside(b, a);
}

function isSameOrInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isStrictlyInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function formatPath(abs) {
  return toPosix(path.relative(repoRoot, abs));
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
NODE
  )
}

list_output="$(cd "$repo_root" && node scripts/run-smoke-examples.mjs --list "$group")"
configs=()
while IFS= read -r config; do
  [[ -n "$config" ]] && configs+=("$config")
done <<< "$list_output"

if [[ "${#configs[@]}" -eq 0 ]]; then
  printf 'No example configs found for group: %s\n' "$group" >&2
  exit 1
fi

for config in "${configs[@]}"; do
  example_rel="${config%/lionden.config.ts}"
  printf '\n==> %s\n' "$example_rel"

  printf -- '--> cleanup\n'
  cleanup_example "$config" "$dry_run"

  if [[ "$dry_run" -eq 1 ]]; then
    printf -- '--> dry-run: skipping compile and typecheck\n'
    continue
  fi

  printf -- '--> compile\n'
  (
    cd "$repo_root"
    node --import tsx packages/cli/src/bin.ts --config "$config" compile --force
  )

  printf -- '--> typecheck\n'
  (
    cd "$repo_root"
    node node_modules/typescript/bin/tsc -p "$example_rel/tsconfig.json" --noEmit
  )
done
