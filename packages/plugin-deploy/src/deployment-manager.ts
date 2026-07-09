/**
 * DeploymentManager — facade for deployment state, preflight, export, and recovery.
 *
 * Session policy:
 * - Devnode: memory-first. Every async read validates against getProgramSource().
 * - HTTP: disk state trusted after .network.json metadata validation.
 */

import type { LionDenResolvedConfig } from "@lionden/config";
import type { ArtifactStore } from "@lionden/core";
import type { DependencyGraph, ProgramABI } from "@lionden/leo-compiler";
import { discoverUnits, parseAbi, resolveDependencies } from "@lionden/leo-compiler";
import type { NetworkConnection, NetworkManager } from "@lionden/network";
import {
  appendHistory,
  deletePendingMarker,
  listPendingMarkers,
  readAbiSnapshot,
  readAllDeploymentRecords,
  readDeploymentRecord,
  readHistory,
  readNetworkMetadata,
  readPendingMarker,
  writeAbiSnapshot,
  writeDeploymentRecord,
  writeExportBundle,
  writeNetworkMetadata,
  writePendingMarker,
} from "./deployment-state.js";
import type {
  DeploymentHistoryEntry,
  DeploymentRecord,
  ExportBundle,
  ExportedProgram,
  NetworkMetadata,
  PendingDeployment,
  RecoveredDeploymentRecord,
} from "./deployment-types.js";
import { checkProgramOnChain, createDegradedRecord } from "./on-chain-check.js";
import type { DeployPreflightResult } from "./preflight.js";
import { runDeployPreflight } from "./preflight.js";

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
  getPending(network: string, programId: string): Promise<PendingDeployment | null>;
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

  // --- Ephemeral ---
  isEphemeral(network: string): boolean;
  getCachedAbi(programId: string, network?: string): ProgramABI | null;

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

  /** In-memory ABI cache: network → programId → ABI (populated by record() for all networks) */
  private readonly abiCache = new Map<string, Map<string, ProgramABI>>();

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

  private networkAbiCache(network: string): Map<string, ProgramABI> {
    let ac = this.abiCache.get(network);
    if (!ac) {
      ac = new Map();
      this.abiCache.set(network, ac);
    }
    return ac;
  }

  // ---------------------------------------------------------------------------
  // Ephemeral
  // ---------------------------------------------------------------------------

  isEphemeral(network: string): boolean {
    const nc = this.config.networks[network];
    return nc?.ephemeral ?? nc?.type === "devnode";
  }

  getCachedAbi(programId: string, network?: string): ProgramABI | null {
    const net = this.resolveNetwork(network);
    return this.abiCache.get(net)?.get(programId) ?? null;
  }

  private requireProgramEdition(
    programId: string,
    edition: number | null,
    actionDescription: string,
  ): number {
    if (typeof edition === "number" && Number.isInteger(edition) && edition >= 0) {
      return edition;
    }
    throw new Error(
      `Unable to ${actionDescription} for "${programId}": on-chain program edition could not be observed.`,
    );
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

      const onChain = await checkProgramOnChain(connection, programId);

      if (!onChain.exists) {
        nc.delete(programId);
        return null;
      }

      // On-chain — return existing record (cache preferred, disk as fallback).
      // Disk fallback only for non-ephemeral devnode (ephemeral: false opt-in).
      // When ephemeral (default), disk state is never read — it may be stale from
      // a previous session or process.
      const existing =
        nc.get(programId) ??
        (this.isEphemeral(net) ? null : readDeploymentRecord(this.deploymentsDir, net, programId));
      if (existing) {
        nc.set(programId, existing);
        return existing;
      }

      const observedEdition = this.requireProgramEdition(
        programId,
        onChain.edition,
        "create degraded deployment record",
      );
      const degraded = createDegradedRecord(
        programId,
        net,
        connection.endpoint,
        onChain.source,
        observedEdition,
      );
      nc.set(programId, degraded);
      return degraded;
    }

    // HTTP network
    if (this.isEphemeral(net)) {
      // Ephemeral HTTP: cache-only, skip metadata validation and disk reads
      return nc.get(programId) ?? null;
    }

    await this.validateHttpMetadata(net);

    const existing = nc.get(programId) ?? readDeploymentRecord(this.deploymentsDir, net, programId);
    if (existing) {
      const manager = this.networkAccessor();
      if (!manager) {
        throw new Error(
          `Unable to validate deployment record for "${programId}" on "${net}": network manager is not available.`,
        );
      }
      const connection = await manager.connect(net);
      const onChain = await checkProgramOnChain(connection, programId);
      if (!onChain.exists) {
        nc.delete(programId);
        return null;
      }
      nc.set(programId, existing);
      return existing;
    }

    return null;
  }

  async getAllDeployments(network?: string): Promise<DeploymentRecord[]> {
    const net = this.resolveNetwork(network);
    const networkConfig = this.config.networks[net];
    const nc = this.networkCache(net);

    if (networkConfig?.type === "devnode") {
      const manager = this.networkAccessor();
      const connection = manager?.getConnection();

      if (!connection) {
        return [...nc.values()];
      }

      const candidateIds = new Set<string>(nc.keys());
      if (!this.isEphemeral(net)) {
        for (const record of readAllDeploymentRecords(this.deploymentsDir, net)) {
          if (!candidateIds.has(record.programId)) {
            candidateIds.add(record.programId);
          }
        }
      }

      const records: DeploymentRecord[] = [];
      for (const programId of candidateIds) {
        const record = await this.getDeployment(programId, net);
        if (record) {
          records.push(record);
        }
      }
      return records;
    }

    if (this.isEphemeral(net)) {
      // Ephemeral HTTP: cache-only
      return [...nc.values()];
    }

    // Non-ephemeral: validate metadata (HTTP) then read from disk
    if (networkConfig?.type === "http") {
      await this.validateHttpMetadata(net);
    }
    const candidateIds = new Set<string>(nc.keys());
    for (const record of readAllDeploymentRecords(this.deploymentsDir, net)) {
      candidateIds.add(record.programId);
    }
    const records: DeploymentRecord[] = [];
    for (const programId of candidateIds) {
      const record = await this.getDeployment(programId, net);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  async isDeployed(programId: string, network?: string): Promise<boolean> {
    return (await this.getDeployment(programId, network)) !== null;
  }

  async getHistory(programId: string, network?: string): Promise<DeploymentHistoryEntry[]> {
    const net = this.resolveNetwork(network);
    if (this.isEphemeral(net)) return [];
    return readHistory(this.deploymentsDir, net, programId);
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

    const edition = (record as unknown as { readonly edition?: unknown }).edition;
    if (!(typeof edition === "number" && Number.isInteger(edition) && edition >= 0)) {
      throw new Error(
        `Cannot record deployment for "${programId}": on-chain program edition is required.`,
      );
    }

    // Enforce ABI for complete records — export consumers rely on it
    if (record.status === "complete" && !options?.abi) {
      throw new Error(
        `ABI is required when recording a complete deployment for "${programId}". ` +
          `Pass options.abi to manager.record() when status is "complete".`,
      );
    }

    const ephemeral = this.isEphemeral(net);

    if (!ephemeral) {
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
    }

    // Always: populate in-memory ABI cache when ABI provided.
    // Normalize through parseAbi() so getCachedAbi() always returns a fully-normalized
    // ProgramABI with `transitions` (not the compiler's `functions` format). The artifact
    // store's lazy disk fallback returns raw JSON.parse() output (compiler format), so
    // options.abi may arrive un-normalized when it came through lre.artifacts.getAbi().
    if (options?.abi) {
      const raw = options.abi as ProgramABI;
      const normalized = parseAbi(JSON.stringify(raw));
      this.networkAbiCache(net).set(programId, normalized);
    }

    // Always: update in-memory record cache
    this.networkCache(net).set(programId, record);

    if (!ephemeral) {
      // Clear pending marker (atomically committed)
      deletePendingMarker(this.deploymentsDir, net, programId);
    }
  }

  async setPending(pending: PendingDeployment): Promise<void> {
    if (!this.isEphemeral(pending.network)) {
      writePendingMarker(this.deploymentsDir, pending.network, pending);
    }
  }

  async getPending(network: string, programId: string): Promise<PendingDeployment | null> {
    if (this.isEphemeral(network)) return null;
    await this.validateHttpMetadata(network);
    return readPendingMarker(this.deploymentsDir, network, programId);
  }

  async clearPending(network: string, programId: string): Promise<void> {
    if (!this.isEphemeral(network)) {
      deletePendingMarker(this.deploymentsDir, network, programId);
    }
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  async recoverPendingDeployments(
    network: string,
    connection: NetworkConnection,
  ): Promise<RecoveredDeploymentRecord[]> {
    if (this.isEphemeral(network)) return []; // No markers to recover in ephemeral mode
    await this.validateHttpMetadata(network);

    const markerIds = listPendingMarkers(this.deploymentsDir, network);
    const recovered: RecoveredDeploymentRecord[] = [];

    for (const programId of markerIds) {
      const marker = readPendingMarker(this.deploymentsDir, network, programId);
      if (!marker) continue;

      const onChain = await checkProgramOnChain(connection, programId);

      if (!onChain.exists) {
        // Not on-chain — delete marker, nothing to recover
        deletePendingMarker(this.deploymentsDir, network, programId);
        console.info(
          `[DeploymentManager] Pending deployment for "${programId}" not found on-chain. ` +
            `The transaction may not have been broadcast. Clearing pending marker.`,
        );
        continue;
      }

      let recoveredEdition: number;
      if (marker.action === "deploy") {
        recoveredEdition =
          typeof onChain.edition === "number" &&
          Number.isInteger(onChain.edition) &&
          onChain.edition >= 0
            ? onChain.edition
            : 0;
      } else {
        recoveredEdition = this.requireProgramEdition(
          programId,
          onChain.edition,
          "recover pending deployment",
        );
        if (
          typeof marker.previousEdition !== "number" ||
          !Number.isInteger(marker.previousEdition) ||
          marker.previousEdition < 0
        ) {
          deletePendingMarker(this.deploymentsDir, network, programId);
          console.info(
            `[DeploymentManager] Pending upgrade for "${programId}" did not advance on-chain. ` +
              `Clearing pending marker.`,
          );
          continue;
        }
        if (recoveredEdition <= marker.previousEdition) {
          if (typeof marker.blockHeight === "number") {
            console.info(
              `[DeploymentManager] Confirmed upgrade for "${programId}" has not propagated to edition reads yet. ` +
                `Keeping pending marker.`,
            );
            continue;
          }
          deletePendingMarker(this.deploymentsDir, network, programId);
          console.info(
            `[DeploymentManager] Pending upgrade for "${programId}" did not advance on-chain. ` +
              `Clearing pending marker.`,
          );
          continue;
        }
      }
      const existingRecord =
        this.networkCache(network).get(programId) ??
        (this.isEphemeral(network)
          ? null
          : readDeploymentRecord(this.deploymentsDir, network, programId));

      // On-chain — build RecoveredDeploymentRecord
      const recoveredRecord: RecoveredDeploymentRecord = {
        status: "recovered",
        programId,
        network,
        endpoint: connection.endpoint,
        updatedAt: new Date().toISOString(),
        edition: recoveredEdition,
        historyCount: existingRecord ? existingRecord.historyCount + 1 : 0,
        txId: marker.txId ?? null,
        blockHeight: marker.blockHeight ?? null,
        deployerAddress: marker.deployerAddress,
        deployedAt: marker.startedAt,
        feePaid: null,
      };

      await this.record(recoveredRecord, marker.action, {
        historyEntry: { action: marker.action },
      });

      recovered.push(recoveredRecord);

      console.info(`[DeploymentManager] Recovered ${marker.action} for "${programId}".`);
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
    const normalizedIds = programIds.map((id) => (id.endsWith(".aleo") ? id : `${id}.aleo`));

    // Build the dependency graph. discoverUnits() reads .leo source files without
    // compilation.
    const programsDir = this.config.paths.programs;
    const discovered = discoverUnits(programsDir);

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
        programs: normalizedIds.map((programId) => ({
          programId,
          action: "deploy" as const,
        })),
        totalFeeEstimate: undefined,
      };
    }

    // Build program entries: aleoSource from artifacts.
    // getDeployment() (async, validates disk/on-chain) gives accurate existing state.
    const programs: Array<{
      programId: string;
      aleoSource: string | undefined;
      existingRecord: import("./deployment-types.js").DeploymentRecord | null;
    }> = [];
    for (const programId of normalizedIds) {
      const aleoSource = this.artifacts.getAleoSource(programId);
      const existingRecord = await this.getDeployment(programId, network);
      programs.push({
        programId,
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
    const ephemeral = this.isEphemeral(net);

    const records = await this.getAllDeployments(net);

    const programs: Record<string, ExportedProgram> = {};

    for (const record of records) {
      // Ephemeral: skip disk ABI snapshot, use memory cache → artifacts
      // Non-ephemeral: disk snapshot → memory cache → artifacts
      const snapshotAbi = ephemeral
        ? null
        : readAbiSnapshot(this.deploymentsDir, net, record.programId);
      const cachedAbi = this.getCachedAbi(record.programId, net);
      const artifactAbi = this.artifacts.getAbi(record.programId);
      const abi = snapshotAbi ?? cachedAbi ?? (artifactAbi as ProgramABI | undefined) ?? null;

      programs[record.programId] = {
        programId: record.programId,
        abi,
        txId: record.status === "complete" ? record.txId : null,
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
    this.abiCache.delete(network);
    this.metadataValidated.delete(network);
  }
}
