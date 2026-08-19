/**
 * Access to the committed Leo CLI capture corpus.
 *
 * The captures under `__fixtures__/leo-cli/` are verbatim recordings of real
 * `leo deploy` / `leo upgrade` runs against a devnode. They exist so the
 * outcome parser can be tested against what Leo actually emits — including its
 * exit-0-on-failure cases — without a Leo binary or a devnode.
 *
 * See that directory's README for provenance and the per-case revision table.
 */

import fs from "node:fs";
import path from "node:path";

const FIXTURE_ROOT = path.join(import.meta.dirname, "__fixtures__", "leo-cli");

/** One captured invocation. Field names match the files on disk. */
export interface LeoCliCapture {
  readonly name: string;
  readonly argv: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** `--json-output` contents, or null when Leo never wrote the file. */
  readonly jsonOutput: string | null;
  /** `--save` directory contents, file name -> text. Empty when none. */
  readonly savedFiles: ReadonlyMap<string, string>;
}

export function leoCliFixtureRoot(): string {
  return FIXTURE_ROOT;
}

export function listLeoCliCaptures(): string[] {
  return fs
    .readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && fs.existsSync(path.join(FIXTURE_ROOT, e.name, "exit-code.txt")),
    )
    .map((e) => e.name)
    .sort();
}

export function loadLeoCliCapture(name: string): LeoCliCapture {
  const dir = path.join(FIXTURE_ROOT, name);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `No Leo CLI capture named "${name}". Available: ${listLeoCliCaptures().join(", ")}`,
    );
  }

  const read = (file: string): string | null => {
    const full = path.join(dir, file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  };

  const savedFiles = new Map<string, string>();
  const saveDir = path.join(dir, "save");
  if (fs.existsSync(saveDir)) {
    for (const file of fs.readdirSync(saveDir).sort()) {
      savedFiles.set(file, fs.readFileSync(path.join(saveDir, file), "utf8"));
    }
  }

  return {
    name,
    argv: read("argv.txt") ?? "",
    exitCode: Number((read("exit-code.txt") ?? "").trim()),
    stdout: read("stdout.txt") ?? "",
    stderr: read("stderr.txt") ?? "",
    jsonOutput: read("json-output.json"),
    savedFiles,
  };
}
