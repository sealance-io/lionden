/**
 * Pre-broadcast upgrade-checksum accessor.
 *
 * ARC-0006 `@checksum` constructors gate an upgrade on a governance-approved
 * program checksum: the constructor asserts `self.checksum == approved[key]`. To
 * drive the *accept* path a caller must seed that approval with the pending v2's
 * checksum BEFORE broadcasting the upgrade — but the upgrade task only computes
 * the checksum internally, at broadcast time. These helpers surface it
 * pre-broadcast: read the compiled v2 `.aleo`, hash it via the SDK's
 * `programChecksum`, and format the bytes as the Leo `[u8; 32]` literal the
 * `approve(...)` call expects.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AleoNetwork } from "@lionden/config";
import { computeProgramChecksum } from "@lionden/network";
import { DeployError } from "./errors.js";

/** Read a compiled program's `.aleo` source from `artifacts/<programId>/main.aleo`. */
export function readCompiledAleoSource(artifactsDir: string, programId: string): string {
  const aleoPath = path.join(artifactsDir, programId, "main.aleo");
  if (!fs.existsSync(aleoPath)) {
    throw new DeployError(
      `No compiled .aleo found for "${programId}" at ${aleoPath}. ` +
        `Compile the program first (e.g. \`lionden compile --program ${programId.replace(/\.aleo$/, "")}\`).`,
    );
  }
  return fs.readFileSync(aleoPath, "utf-8");
}

/**
 * Compute the 32-byte upgrade checksum for a compiled program — the value an
 * `@checksum` constructor compares against the governance-approved checksum.
 * Reads `artifacts/<programId>/main.aleo` and hashes it via the SDK.
 */
export async function computeUpgradeChecksum(
  artifactsDir: string,
  programId: string,
  network: AleoNetwork = "testnet",
): Promise<Uint8Array> {
  return computeProgramChecksum(readCompiledAleoSource(artifactsDir, programId), network);
}

/** Format 32 bytes as a Leo `[u8; 32]` array literal, e.g. `[1u8, 2u8, …, 32u8]`. */
export function formatChecksumLiteral(checksum: Uint8Array): string {
  if (checksum.length !== 32) {
    throw new DeployError(`Expected a 32-byte checksum, got ${checksum.length} bytes.`);
  }
  return `[${Array.from(checksum, (b) => `${b}u8`).join(", ")}]`;
}
