/**
 * DeploymentManager — facade for deployment state, preflight, export, and recovery.
 *
 * Session policy:
 * - Devnode: memory-first. Every async read validates against getProgramSource().
 * - HTTP: disk state trusted after .network.json metadata validation.
 */

import type { LionDenResolvedConfig } from "@lionden/config";
import type { ProgramABI } from "@lionden/leo-compiler";
import {
  discoverUnits,
  resolveDependencies,
  type DiscoveredProgram,
} from "@lionden/leo-compiler";
import type { NetworkConnection, NetworkManager } from "@lionden/network";
import type { ArtifactStore } from "@lionden/core";
import { parseConstructor } from "./constructor-parser.js";
import { readLeoSourcesFromDir } from "./leo-sources.js";
import type {
  DeploymentRecord,
  CompleteDeploymentRecord,
  DegradedDeploymentRecord,
  RecoveredDeploymentRecord,
  DeploymentHistoryEntry,
  NetworkMetadata,
  PendingDeployment,
  ExportBundle,
  ExportedProgram,
} from "./deployment-types.js";
import {
  writeDeploymentRecord,
  readDeploymentRecord,
  readAllDeploymentRecords,
  writeAbiSnapshot,
  readAbiSnapshot,
  appendHistory,
  readHistory,
  writeNetworkMetadata,
  readNetworkMetadata,
  writePendingMarker,
  readPendingMarker,
  deletePendingMarker,
  listPendingMarkers,
  writeExportBundle,
} from "./deployment-state.js";
import { checkProgramOnChain, createDegradedRecord } from "./on-chain-check.js";
import type { DeployPreflightResult } from "./preflight.js";
import { runDeployPreflight } from "./preflight.js";
import type { DependencyGraph } from "@lionden/leo-compiler";

// ---------------------------------------------------------------------------
// DeploymentManager interface
// ---------------------------------------------------------------------------

export interface PreflightOptions {
  /** Default: config.defaultNetwork */
  network?: string;
  /** Default: config.deploy.skipDeployed */
  skipDeployed?: boolean;
}

export interface RecordOptions {
  abi?: ProgramABI;
  historyEntry?: Partial<DeploymentHistoryEntry>;
}

export interface DeploymentManager {
  // --- Async reads (validated) ---
  getDeployment(programId: string, network?: string): Promise<DeploymentRecord | null>;
  getAllDeployments(network?: string): Promise<DeploymentRecord[]>;
  isDeployed(programId: string, network?: string): Promise<boolean>;
  getHistory(programId: string, network?: string): Promise<DeploymentHistoryEntry[]>;

  // --- Sync reads (cache-only) ---
  getCached(programId: string, network?: string): DeploymentRecord | null;
  isCachedDeployed(programId: string, network?: string): boolean;

  // --- State mutations ---
  record(
    record: DeploymentRecord,
    action: "deploy" | "upgrade",
    options?: RecordOptions,
  ): Promise<void>;
  setPending(pending: PendingDeployment): Promise<void>;
  clearPending(network: string, programId: string): Promise<void>;

  // --- Recovery ---
  recoverPendingDeployments(
    network: string,
    connection: NetworkConnection,
  ): Promise<RecoveredDeploymentRecord[]>;

  // --- Preflight (programmatic API) ---
  preflight(programIds: string[], options?: PreflightOptions): Promise<DeployPreflightResult>;

  // --- Export ---
  export(network?: string): Promise<ExportBundle>;

  // --- Session ---
  invalidateSession(network: string): void;
}

// ---------------------------------------------------------------------------
// DeploymentManagerImpl
// ---------------------------------------------------------------------------

export class DeploymentManagerImpl implements DeploymentManager {
  private readonly config: LionDenResolvedConfig;
  private readonly networkAccessor: () => NetworkManager | null;
  private readonly artifacts: ArtifactStore;

  /** In-memory cache: network → programId → record */
  private readonly cache = new Map<string, Map<string, DeploymentRecord>>();

  /** Memoized metadata validation results: network → "valid" | "invalid" | null */
  private readonly metadataValidated = new Map<string, boolean>();

  constructor(
    config: LionDenResolvedConfig,
    networkAccessor: () => NetworkManager | null,
    artifacts: ArtifactStore,
  ) {
    this.config = config;
    this.networkAccessor = networkAccessor;
    this.artifacts = artifacts;
  }

  private get deploymentsDir(): string {
    return this.config.paths.deployments;
  }

  private resolveNetwork(network?: string): string {
    return network ?? this.config.defaultNetwork;
  }

  private networkCache(network: string): Map<string, DeploymentRecord> {
    let nc = this.cache.get(network);
    if (!nc) {
      nc = new Map();
      this.cache.set(network, nc);
    }
    return nc;
  }

  // ---------------------------------------------------------------------------
  // HTTP metadata validation
  // ---------------------------------------------------------------------------

  /**
   * Validate .network.json for an HTTP network before trusting disk state.
   * Throws on mismatch. Returns true when valid, false when metadata absent + no records.
   */
  private async validateHttpMetadata(network: string): Promise<void> {
    // Already validated this session
    if (this.metadataValidated.get(network) === true) return;

    const networkConfig = this.config.networks[network];
    if (!networkConfig || networkConfig.type !== "http") return;

    const meta = readNetworkMetadata(this.deploymentsDir, network);

    if (meta !== null) {
      // Metadata exists — validate it matches config
      const configEndpoint = networkConfig.endpoint;
      const configNetworkId = networkConfig.network;

      if (
        meta.type !== "http" ||
        meta.networkId !== configNetworkId ||
        meta.endpoint !== configEndpoint
      ) {
        throw new Error(
          `Network metadata mismatch for "${network}": ` +
          `config says type=${networkConfig.type}, networkId=${configNetworkId}, endpoint=${configEndpoint} ` +
          `but deployments/.network.json says type=${meta.type}, networkId=${meta.networkId}, endpoint=${meta.endpoint}. ` +
          `This may mean the network was reconfigured. ` +
          `Delete deployments/${network}/ to reset.`,
        );
      }

      this.metadataValidated.set(network, true);
      return;
    }

    // Metadata absent — check if any record files exist
    const records = readAllDeploymentRecords(this.deploymentsDir, network);
    if (records.length > 0) {
      throw new Error(
        `Deployment records exist for "${network}" but .network.json is missing. ` +
        `This state is unverifiable. ` +
        `Delete deployments/${network}/ and re-deploy, or create .network.json manually.`,
      );
    }

    // Empty state — metadata will be written on first record()
    this.metadataValidated.set(network, true);
  }

  // ---------------------------------------------------------------------------
  // Async reads
  // ---------------------------------------------------------------------------

  async getDeployment(programId: string, network?: string): Promise<DeploymentRecord | null> {
    const net = this.resolveNetwork(network);
    const networkConfig = this.config.networks[net];
    const nc = this.networkCache(net);

    if (networkConfig?.type === "devnode") {
      // Devnode: always validate on-chain
      const manager = this.networkAccessor();
      const connection = manager?.getConnection();

      if (!connection) {
        // No connection yet — return cache only
        return nc.get(programId) ?? null;
      }

      const { exists, source } = await checkProgramOnChain(connection, programId);

      if (!exists) {
        nc.delete(programId);
        return null;
      }

      // On-chain — return existing record (cache preferred, disk as fallback).
      // Disk state for devnode is not guaranteed to be current (another process or a previous
      // session may have left stale records), but it is the best available source of provenance
      // data (constructor type, edition, admin address) for programs that are still on-chain.
      // Bulk operations (getAllDeployments) remain cache-only to avoid loading stale records
      // that are no longer on-chain.
      const existing = nc.get(programId) ?? readDeploymentRecord(this.deploymentsDir, net, programId);
      if (existing) {
        nc.set(programId, existing);
        return existing;
      }

      const degraded = createDegradedRecord(programId, net, connection.endpoint, source!);
      nc.set(programId, degraded);
      return degraded;
    }

    // HTTP network
    await this.validateHttpMetadata(net);

    // Cache hit
    const cached = nc.get(programId);
    if (cached) return cached;

    // Disk read
    const disk = readDeploymentRecord(this.deploymentsDir, net, programId);
    if (disk) {
      nc.set(programId, disk);
      return disk;
    }

    return null;
  }

  async getAllDeployments(network?: string): Promise<DeploymentRecord[]> {
    const net = this.resolveNetwork(network);
    const networkConfig = this.config.networks[net];
    const nc = this.networkCache(net);

    if (networkConfig?.type === "devnode") {
      // Devnode: return cache only (disk may be stale from a previous session)
      return [...nc.values()];
    }

    // HTTP: validate metadata then read from disk
    await this.validateHttpMetadata(net);
    const records = readAllDeploymentRecords(this.deploymentsDir, net);
    for (const r of records) {
      if (!nc.has(r.programId)) {
        nc.set(r.programId, r);
      }
    }
    return [...nc.values()];
  }

  async isDeployed(programId: string, network?: string): Promise<boolean> {
    return (await this.getDeployment(programId, network)) !== null;
  }

  async getHistory(programId: string, network?: string): Promise<DeploymentHistoryEntry[]> {
    return readHistory(this.deploymentsDir, this.resolveNetwork(network), programId);
  }

  // ---------------------------------------------------------------------------
  // Sync reads (cache-only)
  // ---------------------------------------------------------------------------

  getCached(programId: string, network?: string): DeploymentRecord | null {
    return this.networkCache(this.resolveNetwork(network)).get(programId) ?? null;
  }

  isCachedDeployed(programId: string, network?: string): boolean {
    return this.getCached(programId, network) !== null;
  }

  // ---------------------------------------------------------------------------
  // State mutations
  // ---------------------------------------------------------------------------

  async record(
    record: DeploymentRecord,
    action: "deploy" | "upgrade",
    options?: RecordOptions,
  ): Promise<void> {
    const net = record.network;
    const programId = record.programId;

    // Enforce ABI snapshot for complete records — upgrade validation relies on it
    if (record.status === "complete" && !options?.abi) {
      throw new Error(
        `ABI snapshot is required when recording a complete deployment for "${programId}". ` +
          `Pass options.abi to manager.record() when status is "complete".`,
      );
    }

    // Write network metadata on first record() for HTTP networks
    const networkConfig = this.config.networks[net];
    if (networkConfig?.type === "http") {
      const existing = readNetworkMetadata(this.deploymentsDir, net);
      if (!existing) {
        const meta: NetworkMetadata = {
          type: "http",
          networkId: networkConfig.network,
          endpoint: networkConfig.endpoint,
        };
        writeNetworkMetadata(this.deploymentsDir, net, meta);
        this.metadataValidated.set(net, true);
      }
    }

    // Write ABI snapshot if provided
    if (options?.abi) {
      writeAbiSnapshot(this.deploymentsDir, net, programId, options.abi);
    }

    // Write deployment record
    writeDeploymentRecord(this.deploymentsDir, net, record);

    // Append history
    const historyEntry: DeploymentHistoryEntry = {
      record,
      action,
      ...(options?.historyEntry ?? {}),
    };
    appendHistory(this.deploymentsDir, net, programId, historyEntry);

    // Update cache
    this.networkCache(net).set(programId, record);

    // Clear pending marker (atomically committed)
    deletePendingMarker(this.deploymentsDir, net, programId);
  }

  async setPending(pending: PendingDeployment): Promise<void> {
    writePendingMarker(this.deploymentsDir, pending.network, pending);
  }

  async clearPending(network: string, programId: string): Promise<void> {
    deletePendingMarker(this.deploymentsDir, network, programId);
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  async recoverPendingDeployments(
    network: string,
    connection: NetworkConnection,
  ): Promise<RecoveredDeploymentRecord[]> {
    const markerIds = listPendingMarkers(this.deploymentsDir, network);
    const recovered: RecoveredDeploymentRecord[] = [];

    for (const programId of markerIds) {
      const marker = readPendingMarker(this.deploymentsDir, network, programId);
      if (!marker) continue;

      const { exists, edition, source } = await checkProgramOnChain(connection, programId);

      if (!exists) {
        // Not on-chain — delete marker, nothing to recover
        deletePendingMarker(this.deploymentsDir, network, programId);
        console.info(
          `[DeploymentManager] Pending deployment for "${programId}" not found on-chain. ` +
          `The transaction may not have been broadcast. Clearing pending marker.`,
        );
        continue;
      }

      // On-chain — build RecoveredDeploymentRecord
      const recoveredRecord: RecoveredDeploymentRecord = {
        status: "recovered",
        programId,
        edition: edition ?? marker.expectedEdition ?? 0,
        constructor: marker.constructor,
        abiHash: marker.abiHash,
        network,
        endpoint: connection.endpoint,
        updatedAt: new Date().toISOString(),
        historyCount: 0,
        txId: null,
        blockHeight: null,
        deployerAddress: marker.deployerAddress,
        deployedAt: marker.startedAt,
        feePaid: null,
      };

      await this.record(recoveredRecord, marker.action, {
        historyEntry: {
          action: marker.action,
          previousEdition:
            marker.action === "upgrade" && marker.expectedEdition !== undefined
              ? marker.expectedEdition - 1
              : undefined,
        },
      });

      void source; // source available but we don't need it for RecoveredRecord
      recovered.push(recoveredRecord);

      console.info(
        `[DeploymentManager] Recovered ${marker.action} for "${programId}" (edition ${recoveredRecord.edition}).`,
      );
    }

    return recovered;
  }

  // ---------------------------------------------------------------------------
  // Preflight (programmatic API)
  // ---------------------------------------------------------------------------

  async preflight(
    programIds: string[],
    options?: PreflightOptions,
  ): Promise<DeployPreflightResult> {
    const network = options?.network ?? this.config.defaultNetwork;
    const skipDeployed = options?.skipDeployed ?? this.config.deploy.skipDeployed;
    const networkConfig = this.config.networks[network];

    if (!networkConfig) {
      throw new Error(
        `Network "${network}" not found in config. ` +
        `Available: ${Object.keys(this.config.networks).join(", ") || "none"}`,
      );
    }

    const manager = this.networkAccessor();
    if (!manager) {
      throw new Error("Network manager not available. Ensure @lionden/plugin-network is loaded.");
    }

    const connection = await manager.connect(network);

    // Normalize program IDs
    const normalizedIds = programIds.map((id) =>
      id.endsWith(".aleo") ? id : `${id}.aleo`,
    );

    // Parse Leo sources for constructor info and build dependency graph.
    // discoverUnits() reads .leo source files without compilation.
    const programsDir = this.config.paths.programs;
    const discovered = discoverUnits(programsDir);
    const programUnits = discovered.filter((u): u is DiscoveredProgram => u.kind === "program");

    let graph: DependencyGraph;
    try {
      graph = resolveDependencies(discovered);
    } catch (err) {
      // Propagate dependency resolution failures (e.g. cycles, malformed imports)
      // as a fatal preflight error rather than silently using an empty graph.
      const message = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        warnings: [],
        errors: [
          {
            code: "DEPENDENCY_RESOLUTION_FAILED",
            message: `Failed to resolve program dependencies: ${message}`,
            recoverable: false,
          },
        ],
        programs: normalizedIds.map((programId) => ({ programId, action: "deploy" as const })),
        totalFeeEstimate: undefined,
      };
    }

    // Build program entries: constructor from Leo sources, aleoSource from artifacts.
    // getDeployment() (async, validates disk/on-chain) gives accurate existing state.
    const programs: Array<{
      programId: string;
      constructor: ReturnType<typeof parseConstructor>;
      aleoSource: string | undefined;
      existingRecord: import("./deployment-types.js").DeploymentRecord | null;
    }> = [];
    for (const programId of normalizedIds) {
      const unit = programUnits.find((p) => p.programId === programId);
      const leoSources = unit ? readLeoSourcesFromDir(unit.sourceDir) : "";
      const constructor = parseConstructor(leoSources);
      const aleoSource = this.artifacts.getAleoSource(programId);
      const existingRecord = await this.getDeployment(programId, network);
      programs.push({
        programId,
        constructor,
        aleoSource: typeof aleoSource === "string" ? aleoSource : undefined,
        existingRecord,
      });
    }

    const deployTargets = new Set(normalizedIds);
    const localSources = new Map<string, string>();
    for (const p of programs) {
      if (p.aleoSource !== undefined) {
        localSources.set(p.programId, p.aleoSource);
      }
    }

    return runDeployPreflight({
      programs,
      connection,
      networkConfig,
      config: this.config,
      skipDeployed,
      deployTargets,
      localSources,
      graph,
    });
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  async export(network?: string): Promise<ExportBundle> {
    const net = this.resolveNetwork(network);
    const networkConfig = this.config.networks[net];

    let records: DeploymentRecord[];

    if (networkConfig?.type === "devnode") {
      // Devnode: cache-only
      records = [...this.networkCache(net).values()];
    } else {
      // HTTP: read from disk
      await this.validateHttpMetadata(net);
      records = await this.getAllDeployments(net);
    }

    const programs: Record<string, ExportedProgram> = {};

    for (const record of records) {
      // Read ABI from snapshot first, fall back to artifact store
      const snapshotAbi = readAbiSnapshot(this.deploymentsDir, net, record.programId);
      const artifactAbi = this.artifacts.getAbi(record.programId);
      const abi = snapshotAbi ?? (artifactAbi as ProgramABI | undefined) ?? null;

      programs[record.programId] = {
        programId: record.programId,
        abi,
        edition: record.edition,
        txId: record.status === "complete" ? record.txId : null,
        constructorType: record.constructor.type,
        adminAddress: record.constructor.adminAddress,
        status: record.status,
      };
    }

    const endpoint =
      networkConfig?.type === "http"
        ? networkConfig.endpoint
        : networkConfig?.type === "devnode"
          ? `http://${networkConfig.socketAddr ?? "127.0.0.1:3030"}`
          : "unknown";

    const bundle: ExportBundle = {
      network: net,
      networkInfo: {
        type: networkConfig?.type ?? "devnode",
        networkId: networkConfig?.network ?? "testnet",
        endpoint,
      },
      exportedAt: new Date().toISOString(),
      programs,
    };

    writeExportBundle(this.deploymentsDir, net, bundle);
    return bundle;
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  invalidateSession(network: string): void {
    this.cache.delete(network);
    this.metadataValidated.delete(network);
  }
}
