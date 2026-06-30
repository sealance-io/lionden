/**
 * On-chain program existence checks.
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
  readonly source: string | null;
}

/**
 * Check whether a program is deployed on-chain.
 * Returns source when found, null when not.
 */
export async function checkProgramOnChain(
  connection: NetworkConnection,
  programId: string,
): Promise<OnChainCheckResult> {
  const source = await connection.getProgramSource(programId);
  if (source === null) {
    return { exists: false, source: null };
  }
  return { exists: true, source };
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
  void source; // source kept in the signature for callers; not stored on the record
  return {
    status: "degraded",
    programId,
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
