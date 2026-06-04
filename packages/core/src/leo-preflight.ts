import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LionDenResolvedConfig } from "@lionden/config";

const execFileAsync = promisify(execFile);
const LEO_VERSION_RE = /\b(\d+)\.(\d+)\.(\d+)(?![-+.\w])/;
const CONFIG_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const memoizedPreflights = new Map<string, Promise<void>>();

export interface ParsedLeoVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly text: string;
}

export function parseLeoVersionOutput(output: string): ParsedLeoVersion | null {
  const match = LEO_VERSION_RE.exec(output);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export async function preflightLeo(config: LionDenResolvedConfig): Promise<void> {
  const expected = parseConfigLeoVersion(config.leoVersion);
  const expectedLine = expected ? `${expected.major}.${expected.minor}` : config.leoVersion;
  const skip = config.skipLeoVersionCheck;
  const key = `${config.leoBinary}\0${expectedLine}\0${skip ? "skip" : "check"}`;

  const memoized = memoizedPreflights.get(key);
  if (memoized) return memoized;

  const promise = runLeoPreflight(config, expected);
  memoizedPreflights.set(key, promise);
  return promise;
}

export function clearLeoPreflightMemoForTests(): void {
  memoizedPreflights.clear();
}

async function runLeoPreflight(
  config: LionDenResolvedConfig,
  expected: ParsedLeoVersion | null,
): Promise<void> {
  const binary = config.leoBinary;
  let stdout = "";
  let stderr = "";

  try {
    const result = await execFileAsync(binary, ["--disable-update-check", "--version"], {
      timeout: 30_000,
    });
    stdout = String(result.stdout);
    stderr = String(result.stderr);
  } catch (err) {
    const e = err as {
      message?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
    };
    const output = formatVersionOutput(e.stdout, e.stderr);
    const reason = [e.code ? `code ${String(e.code)}` : "", e.message ?? "unknown error"]
      .filter(Boolean)
      .join(": ");
    throw new Error(
      `Leo preflight failed for "${binary}": unable to execute ` +
        `"${binary} --disable-update-check --version" (${reason}).` +
        (output ? `\nOutput:\n${output}` : ""),
    );
  }

  if (config.skipLeoVersionCheck) return;

  if (!expected) {
    throw new Error(
      `Leo preflight failed for "${binary}": configured leoVersion ` +
        `"${config.leoVersion}" is not a stable major.minor.patch version.`,
    );
  }

  const output = `${stdout}\n${stderr}`;
  const actual = parseLeoVersionOutput(output);
  if (!actual) {
    const formattedOutput = formatVersionOutput(stdout, stderr);
    throw new Error(
      `Leo preflight failed for "${binary}": could not parse a stable ` +
        `major.minor.patch version from "${binary} --disable-update-check --version".` +
        (formattedOutput ? `\nOutput:\n${formattedOutput}` : ""),
    );
  }

  if (actual.major !== expected.major || actual.minor !== expected.minor) {
    throw new Error(
      `Leo preflight failed for "${binary}": leoBinary reports ${actual.text}, ` +
        `but leoVersion "${config.leoVersion}" requires ${expected.major}.${expected.minor}.x. ` +
        `Set leoBinary to a compatible Leo CLI or set skipLeoVersionCheck: true.`,
    );
  }
}

function parseConfigLeoVersion(version: string): ParsedLeoVersion | null {
  const match = CONFIG_VERSION_RE.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: version,
  };
}

function formatVersionOutput(
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined,
): string {
  const output = [stdout, stderr]
    .map((value) => (value === undefined ? "" : String(value).trim()))
    .filter(Boolean)
    .join("\n")
    .trim();
  return output.slice(0, 1_000);
}
