/**
 * Deploy manifest — tracks deployment state per program.
 *
 * Written to `artifacts/<programId>/deploy.json` after successful deployment.
 * Read during upgrades to validate permissions and track edition.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ConstructorType } from "./constructor-parser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeployManifest {
  readonly programId: string;
  readonly network: string;
  readonly endpoint: string;
  readonly txId: string;
  readonly blockHeight: number;
  readonly edition: number;
  readonly constructorType: ConstructorType;
  readonly constructorAdmin: string | null;
  readonly deployedAt: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a deploy manifest after a successful deployment or upgrade.
 */
export function writeDeployManifest(
  artifactsDir: string,
  manifest: DeployManifest,
): void {
  const dir = path.join(artifactsDir, manifest.programId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "deploy.json");
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/**
 * Read an existing deploy manifest, or return null if not deployed.
 */
export function readDeployManifest(
  artifactsDir: string,
  programId: string,
): DeployManifest | null {
  const filePath = path.join(artifactsDir, programId, "deploy.json");
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as DeployManifest;
}

/**
 * Get the path to the deploy manifest file.
 */
export function deployManifestPath(
  artifactsDir: string,
  programId: string,
): string {
  return path.join(artifactsDir, programId, "deploy.json");
}
