/**
 * Deployment state file I/O.
 *
 * Directory layout under `deploymentsDir`:
 *
 * ```
 * deployments/<networkName>/
 *   .network.json                                   # NetworkMetadata
 *   <programId>.json                                # DeploymentRecord (latest)
 *   <programId>.abi.json                            # ABI snapshot (for upgrade validation)
 *   .history/<programId>/<edition>-<timestamp>.json # historical entries
 *   .pending/<programId>.json                       # crash recovery markers
 * deployments/_exports/<networkName>.json            # export bundles
 * ```
 *
 * All writes use write-to-tmp + rename for atomicity.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProgramABI } from "@lionden/leo-compiler";
import { parseAbi } from "@lionden/leo-compiler";
import type {
  DeploymentHistoryEntry,
  DeploymentRecord,
  ExportBundle,
  NetworkMetadata,
  PendingDeployment,
} from "./deployment-types.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function networkDir(deploymentsDir: string, network: string): string {
  return path.join(deploymentsDir, network);
}

function recordPath(deploymentsDir: string, network: string, programId: string): string {
  return path.join(networkDir(deploymentsDir, network), `${programId}.json`);
}

function abiSnapshotPath(deploymentsDir: string, network: string, programId: string): string {
  return path.join(networkDir(deploymentsDir, network), `${programId}.abi.json`);
}

function networkMetaPath(deploymentsDir: string, network: string): string {
  return path.join(networkDir(deploymentsDir, network), ".network.json");
}

function pendingDir(deploymentsDir: string, network: string): string {
  return path.join(networkDir(deploymentsDir, network), ".pending");
}

function pendingPath(deploymentsDir: string, network: string, programId: string): string {
  return path.join(pendingDir(deploymentsDir, network), `${programId}.json`);
}

function historyDir(deploymentsDir: string, network: string, programId: string): string {
  return path.join(networkDir(deploymentsDir, network), ".history", programId);
}

function exportPath(deploymentsDir: string, network: string): string {
  return path.join(deploymentsDir, "_exports", `${network}.json`);
}

/**
 * Atomic write: write to a temp file, then rename into place.
 */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Deployment records
// ---------------------------------------------------------------------------

export function writeDeploymentRecord(
  deploymentsDir: string,
  network: string,
  record: DeploymentRecord,
): void {
  atomicWrite(
    recordPath(deploymentsDir, network, record.programId),
    JSON.stringify(record, null, 2) + "\n",
  );
}

export function readDeploymentRecord(
  deploymentsDir: string,
  network: string,
  programId: string,
): DeploymentRecord | null {
  const p = recordPath(deploymentsDir, network, programId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as DeploymentRecord;
}

/**
 * Read all deployment records for a network.
 * Excludes dotfiles (`.network.json`, `.history/`, `.pending/`) and
 * ABI snapshots (`*.abi.json`).
 */
export function readAllDeploymentRecords(
  deploymentsDir: string,
  network: string,
): DeploymentRecord[] {
  const dir = networkDir(deploymentsDir, network);
  if (!fs.existsSync(dir)) return [];

  const records: DeploymentRecord[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name.endsWith(".abi.json")) continue;

    try {
      const raw = fs.readFileSync(path.join(dir, entry.name), "utf-8");
      records.push(JSON.parse(raw) as DeploymentRecord);
    } catch {
      // Skip corrupt files
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// ABI snapshots
// ---------------------------------------------------------------------------

export function writeAbiSnapshot(
  deploymentsDir: string,
  network: string,
  programId: string,
  abi: ProgramABI,
): void {
  atomicWrite(
    abiSnapshotPath(deploymentsDir, network, programId),
    JSON.stringify(abi, null, 2) + "\n",
  );
}

export function readAbiSnapshot(
  deploymentsDir: string,
  network: string,
  programId: string,
): ProgramABI | null {
  const p = abiSnapshotPath(deploymentsDir, network, programId);
  if (!fs.existsSync(p)) return null;
  try {
    // Use parseAbi for normalization (ensures all arrays are present, same as readAbiFromArtifacts)
    return parseAbi(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function deleteAbiSnapshot(
  deploymentsDir: string,
  network: string,
  programId: string,
): void {
  fs.rmSync(abiSnapshotPath(deploymentsDir, network, programId), { force: true });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function appendHistory(
  deploymentsDir: string,
  network: string,
  programId: string,
  entry: DeploymentHistoryEntry,
): void {
  const dir = historyDir(deploymentsDir, network, programId);
  const edition = entry.record.edition;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${String(edition).padStart(6, "0")}-${ts}.json`;
  atomicWrite(path.join(dir, filename), JSON.stringify(entry, null, 2) + "\n");
}

export function readHistory(
  deploymentsDir: string,
  network: string,
  programId: string,
): DeploymentHistoryEntry[] {
  const dir = historyDir(deploymentsDir, network, programId);
  if (!fs.existsSync(dir)) return [];

  const entries: DeploymentHistoryEntry[] = [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      entries.push(JSON.parse(raw) as DeploymentHistoryEntry);
    } catch {
      // Skip corrupt files
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Network metadata
// ---------------------------------------------------------------------------

export function writeNetworkMetadata(
  deploymentsDir: string,
  network: string,
  meta: NetworkMetadata,
): void {
  atomicWrite(networkMetaPath(deploymentsDir, network), JSON.stringify(meta, null, 2) + "\n");
}

export function readNetworkMetadata(
  deploymentsDir: string,
  network: string,
): NetworkMetadata | null {
  const p = networkMetaPath(deploymentsDir, network);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as NetworkMetadata;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pending markers
// ---------------------------------------------------------------------------

export function writePendingMarker(
  deploymentsDir: string,
  network: string,
  pending: PendingDeployment,
): void {
  atomicWrite(
    pendingPath(deploymentsDir, network, pending.programId),
    JSON.stringify(pending, null, 2) + "\n",
  );
}

export function readPendingMarker(
  deploymentsDir: string,
  network: string,
  programId: string,
): PendingDeployment | null {
  const p = pendingPath(deploymentsDir, network, programId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as PendingDeployment;
  } catch {
    return null;
  }
}

export function deletePendingMarker(
  deploymentsDir: string,
  network: string,
  programId: string,
): void {
  const p = pendingPath(deploymentsDir, network, programId);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

export function listPendingMarkers(deploymentsDir: string, network: string): string[] {
  const dir = pendingDir(deploymentsDir, network);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
}

// ---------------------------------------------------------------------------
// Export bundles
// ---------------------------------------------------------------------------

export function writeExportBundle(
  deploymentsDir: string,
  network: string,
  bundle: ExportBundle,
): void {
  atomicWrite(exportPath(deploymentsDir, network), JSON.stringify(bundle, null, 2) + "\n");
}
