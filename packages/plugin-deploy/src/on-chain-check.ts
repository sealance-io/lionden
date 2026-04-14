/**
 * On-chain program existence and edition checks.
 *
 * Used by DeploymentManager for devnode session validation and by the
 * pre-flight pipeline to detect already-deployed programs.
 */

import type { NetworkConnection } from "@lionden/network";
import type { DegradedDeploymentRecord } from "./deployment-types.js";

// ---------------------------------------------------------------------------
// checkProgramOnChain
// ---------------------------------------------------------------------------

export interface OnChainCheckResult {
  readonly exists: boolean;
  readonly edition: number | null;
  readonly source: string | null;
}

/**
 * Check whether a program is deployed on-chain.
 * Returns source and edition when found, null values when not.
 */
export async function checkProgramOnChain(
  connection: NetworkConnection,
  programId: string,
): Promise<OnChainCheckResult> {
  const source = await connection.getProgramSource(programId);
  if (source === null) {
    return { exists: false, edition: null, source: null };
  }
  const edition = parseEditionFromSource(source);
  return { exists: true, edition, source };
}

// ---------------------------------------------------------------------------
// parseEditionFromSource
// ---------------------------------------------------------------------------

/**
 * Parse the current edition from a compiled Aleo program's constructor block.
 *
 * The constructor block contains a line like `assert.eq edition 1u16;` which
 * is auto-incremented on each upgrade.
 */
export function parseEditionFromSource(aleoSource: string): number | null {
  // Match `assert.eq edition Xu16` in the constructor block
  const match = /assert\.eq\s+edition\s+(\d+)u16\s*;/.exec(aleoSource);
  if (!match) return null;
  return parseInt(match[1]!, 10);
}

// ---------------------------------------------------------------------------
// createDegradedRecord
// ---------------------------------------------------------------------------

/**
 * Build a DegradedDeploymentRecord from an on-chain program source.
 * Used when a program is discovered on-chain with no local provenance.
 */
export function createDegradedRecord(
  programId: string,
  network: string,
  endpoint: string,
  source: string,
): DegradedDeploymentRecord {
  const edition = parseEditionFromSource(source) ?? 0;
  return {
    status: "degraded",
    programId,
    edition,
    constructor: { type: null },
    abiHash: null,
    network,
    endpoint,
    updatedAt: new Date().toISOString(),
    historyCount: 0,
    txId: null,
    blockHeight: null,
    deployerAddress: null,
    deployedAt: null,
    feePaid: null,
  };
}

// ---------------------------------------------------------------------------
// fetchImportSources
// ---------------------------------------------------------------------------

/**
 * Batch-fetch compiled Aleo sources for a list of program IDs.
 * Missing programs are omitted from the result map.
 */
export async function fetchImportSources(
  connection: NetworkConnection,
  importIds: string[],
): Promise<Map<string, string>> {
  const results = await Promise.all(
    importIds.map(async (id) => {
      const source = await connection.getProgramSource(id);
      return [id, source] as const;
    }),
  );
  const map = new Map<string, string>();
  for (const [id, source] of results) {
    if (source !== null) {
      map.set(id, source);
    }
  }
  return map;
}
