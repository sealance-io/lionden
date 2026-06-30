/**
 * Deployment state types.
 *
 * Defines the record union (CompleteDeploymentRecord | DegradedDeploymentRecord |
 * RecoveredDeploymentRecord), history entries, network metadata, pending markers,
 * and export bundle shapes.
 */

import type { AleoNetwork } from "@lionden/config";
import type { ProgramABI } from "@lionden/leo-compiler";

// ---------------------------------------------------------------------------
// Base record fields shared by all statuses
// ---------------------------------------------------------------------------

interface DeploymentRecordBase {
  readonly programId: string;
  /** Name of the network in config (e.g. "devnode", "testnet") */
  readonly network: string;
  /** REST API endpoint of the node */
  readonly endpoint: string;
  /** ISO 8601 timestamp of last update */
  readonly updatedAt: string;
  /** Number of historical entries for this program */
  readonly historyCount: number;
}

// ---------------------------------------------------------------------------
// Record variants
// ---------------------------------------------------------------------------

/**
 * Full provenance — written after a successful deploy or upgrade.
 */
export interface CompleteDeploymentRecord extends DeploymentRecordBase {
  readonly status: "complete";
  readonly txId: string;
  readonly blockHeight: number;
  readonly deployerAddress: string;
  readonly deployedAt: string;
  readonly feePaid?: number;
}

/**
 * Discovered on-chain with no local provenance (imported from another
 * deploy process, or present before LionDen was used).
 */
export interface DegradedDeploymentRecord extends DeploymentRecordBase {
  readonly status: "degraded";
  readonly txId: null;
  readonly blockHeight: null;
  readonly deployerAddress: null;
  readonly deployedAt: null;
  readonly feePaid: null;
}

/**
 * Recovered from a pending marker after a crash — we know the intent and
 * deployer but not the confirmed block height.
 */
export interface RecoveredDeploymentRecord extends DeploymentRecordBase {
  readonly status: "recovered";
  readonly txId: null;
  readonly blockHeight: null;
  readonly deployerAddress: string;
  readonly deployedAt: string;
  readonly feePaid: null;
}

export type DeploymentRecord =
  | CompleteDeploymentRecord
  | DegradedDeploymentRecord
  | RecoveredDeploymentRecord;

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface DeploymentHistoryEntry {
  readonly record: DeploymentRecord;
  readonly action: "deploy" | "upgrade";
}

// ---------------------------------------------------------------------------
// Network metadata
// ---------------------------------------------------------------------------

/**
 * Written to `deployments/<network>/.network.json`.
 * Used to detect config drift (e.g. "testnet" endpoint changed).
 */
export interface NetworkMetadata {
  readonly type: "devnode" | "http";
  readonly networkId: AleoNetwork;
  readonly endpoint: string;
  /** Reserved for future genesis-hash verification */
  readonly chainIdentifier?: string;
}

// ---------------------------------------------------------------------------
// Pending deployment marker
// ---------------------------------------------------------------------------

/**
 * Written to `deployments/<network>/.pending/<programId>.json` before
 * broadcast, deleted by `record()` after confirmation.
 * Used for crash recovery.
 */
export interface PendingDeployment {
  readonly programId: string;
  readonly action: "deploy" | "upgrade";
  readonly startedAt: string;
  readonly deployerAddress: string;
  readonly priorityFee: number;
  readonly privateFee: boolean;
  readonly network: string;
  readonly endpoint: string;
}

// ---------------------------------------------------------------------------
// Export bundle
// ---------------------------------------------------------------------------

export interface ExportedProgram {
  readonly programId: string;
  readonly abi: ProgramABI | null;
  readonly txId: string | null;
  readonly status: "complete" | "degraded" | "recovered";
}

export interface ExportBundle {
  readonly network: string;
  readonly networkInfo: {
    readonly type: "devnode" | "http";
    readonly networkId: AleoNetwork;
    readonly endpoint: string;
  };
  readonly exportedAt: string;
  readonly programs: Record<string, ExportedProgram>;
}
