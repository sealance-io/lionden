import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function git(rootDir, args, env = process.env) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8", env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * Materializes every tracked file at `ref` into a fresh temporary directory and returns its
 * path. Uses a throwaway index (`read-tree` + `checkout-index`), not `git archive`: archives
 * honor `export-ignore` attributes committed in the tree, so an excluded manifest would silently
 * vanish from the export. Never touches the repository's worktree or index. The caller removes
 * the directory; on failure nothing is left behind.
 */
export function exportTree(rootDir, ref) {
  const dir = mkdtempSync(join(tmpdir(), "git-tree-"));
  try {
    const index = join(dir, ".export-index");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(rootDir, ["read-tree", ref], env);
    git(rootDir, ["checkout-index", "--all", `--prefix=${join(dir, "tree")}/`], env);
    rmSync(index);
    return join(dir, "tree");
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Runs `fn(dir)` against the exported tree at `ref` and always removes the export. */
export async function withExportedTree(rootDir, ref, fn) {
  const dir = exportTree(rootDir, ref);
  try {
    return await fn(dir);
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
}
