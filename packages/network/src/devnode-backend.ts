/**
 * Devnode backend resolution and preflight.
 *
 * Lionden can drive two devnode backends:
 * - `"leo"`: the devnode bundled in the Leo CLI (`leo devnode start`).
 * - `"standalone"`: Provable's standalone `aleo-devnode` binary.
 *
 * When the user doesn't pin a `provider`, the backend is auto-detected by
 * probing `aleo-devnode --version`. Standalone-only inputs (an explicit binary,
 * persistence/snapshot) force the standalone backend and fail clearly if it
 * isn't available rather than silently falling back to `leo`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LionDenResolvedConfig } from "@lionden/config";
import { preflightLeo } from "@lionden/core";
import type { DevnodeProvider } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_STANDALONE_BINARY = "aleo-devnode";
const PROBE_TIMEOUT_MS = 30_000;

export interface DevnodeBackend {
  readonly provider: DevnodeProvider;
  /** Binary to spawn for this backend. */
  readonly command: string;
  readonly capabilities: { readonly snapshot: boolean };
}

export interface ResolveDevnodeBackendOptions {
  /** Explicit backend pin. Undefined ⇒ auto-detect. */
  provider?: DevnodeProvider;
  /** Leo CLI binary (already tilde-expanded). Default: "leo". */
  leoBinary?: string;
  /** Explicit standalone binary path. Setting this forces standalone. */
  binary?: string;
  /** Configured network — standalone rejects anything but "testnet". */
  network?: string;
  /** Configured consensus heights — rejected on standalone. */
  consensusHeights?: string;
  /** Whether persistence/snapshot is requested (forces standalone). */
  requiresPersistence?: boolean;
}

const probeCache = new Map<string, Promise<boolean>>();

function probeStandalone(binary: string): Promise<boolean> {
  let p = probeCache.get(binary);
  if (!p) {
    p = execFileAsync(binary, ["--version"], { timeout: PROBE_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    probeCache.set(binary, p);
  }
  return p;
}

/** Clear the memoized `aleo-devnode --version` probe results (tests only). */
export function clearDevnodeBackendProbeCacheForTests(): void {
  probeCache.clear();
}

function assertStandaloneNetwork(network?: string, consensusHeights?: string): void {
  if (network !== undefined && network !== "testnet") {
    throw new Error(
      `The standalone aleo-devnode backend only supports the "testnet" network, but ` +
        `network "${network}" was configured. Use network: "testnet" or provider: "leo".`,
    );
  }
  if (consensusHeights !== undefined) {
    throw new Error(
      `consensusHeights is not supported on the standalone aleo-devnode backend ` +
        `(consensus heights are compiled in). Remove consensusHeights or use provider: "leo".`,
    );
  }
}

function leoBackend(leoBinary?: string): DevnodeBackend {
  return { provider: "leo", command: leoBinary ?? "leo", capabilities: { snapshot: false } };
}

function standaloneBackend(command: string): DevnodeBackend {
  return { provider: "standalone", command, capabilities: { snapshot: true } };
}

/**
 * Resolve which devnode backend to use, honoring an explicit `provider`, an
 * explicit `binary`, and any standalone-only feature request. Performs a
 * (memoized) `--version` probe when auto-detecting or when a standalone-only
 * input is present. Throws — never silently falls back to `leo` — when a
 * standalone-only input cannot be satisfied.
 */
export async function resolveDevnodeBackend(
  options: ResolveDevnodeBackendOptions = {},
): Promise<DevnodeBackend> {
  const { provider, leoBinary, binary, network, consensusHeights, requiresPersistence } =
    options;

  const explicitBinary = binary !== undefined;
  const standaloneBinary = binary ?? DEFAULT_STANDALONE_BINARY;
  const wantsStandaloneFeature = requiresPersistence === true || explicitBinary;

  if (provider === "leo") {
    if (wantsStandaloneFeature) {
      throw new Error(
        `Devnode persistence/snapshot features require the standalone "aleo-devnode" ` +
          `backend, but provider is pinned to "leo". Remove provider: "leo" or set ` +
          `provider: "standalone".`,
      );
    }
    return leoBackend(leoBinary);
  }

  if (provider === "standalone") {
    assertStandaloneNetwork(network, consensusHeights);
    return standaloneBackend(standaloneBinary);
  }

  // Auto-detect.
  if (wantsStandaloneFeature) {
    const ok = await probeStandalone(standaloneBinary);
    if (!ok) {
      throw new Error(
        explicitBinary
          ? `Configured devnode binary "${standaloneBinary}" could not be executed ` +
            `("${standaloneBinary} --version" failed). Ensure the standalone aleo-devnode ` +
            `binary is installed and on PATH.`
          : `Devnode persistence/snapshot features require the standalone "aleo-devnode" ` +
            `binary, but it could not be found on PATH. Install aleo-devnode or remove the ` +
            `persistence option.`,
      );
    }
    assertStandaloneNetwork(network, consensusHeights);
    return standaloneBackend(standaloneBinary);
  }

  if (await probeStandalone(standaloneBinary)) {
    assertStandaloneNetwork(network, consensusHeights);
    return standaloneBackend(standaloneBinary);
  }
  return leoBackend(leoBinary);
}

/**
 * Verify the resolved devnode backend can run. Leo delegates to the existing
 * `preflightLeo` (which also checks the configured Leo version). Standalone
 * asserts the binary responds to `--version`.
 */
export async function preflightDevnode(
  config: LionDenResolvedConfig,
  backend: DevnodeBackend,
): Promise<void> {
  if (backend.provider === "leo") {
    await preflightLeo(config);
    return;
  }
  try {
    await execFileAsync(backend.command, ["--version"], { timeout: PROBE_TIMEOUT_MS });
  } catch (err) {
    const e = err as { message?: string; code?: string | number };
    const reason = [
      e.code !== undefined ? `code ${String(e.code)}` : "",
      e.message ?? "unknown error",
    ]
      .filter(Boolean)
      .join(": ");
    throw new Error(
      `aleo-devnode preflight failed for "${backend.command}": unable to run ` +
        `"${backend.command} --version" (${reason}). Ensure the standalone aleo-devnode ` +
        `binary is installed and on PATH.`,
    );
  }
}
